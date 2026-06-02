from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


SOURCE_URL = "https://activesg.gov.sg/gym-pool-crowd"
FACILITY_NAME = "Clementi ActiveSG Gym"
API_FRAGMENT = "pass.getFacilityCapacities"
CSV_PATH = Path("public/data/clementi_gym_capacity.csv")
LATEST_JSON_PATH = Path("public/data/latest.json")
SGT = ZoneInfo("Asia/Singapore")


@dataclass
class CapacityReading:
    scraped_at: str
    source_updated_at: str
    facility: str
    status: str
    capacity_percentage: str
    badge_text: str
    raw_text: str
    source: str


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(dt: datetime | None) -> str:
    return dt.isoformat(timespec="seconds") if dt else ""


def find_capacity_payload(payload: Any) -> dict[str, Any] | None:
    if isinstance(payload, dict):
        if isinstance(payload.get("gymFacilities"), list):
            return payload
        for value in payload.values():
            found = find_capacity_payload(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = find_capacity_payload(value)
            if found:
                return found
    return None


def parse_source_updated_at(text: str) -> datetime | None:
    match = re.search(r"Last updated at\s+(.+)", text, flags=re.IGNORECASE)
    if not match:
        return None

    raw_value = match.group(1).strip()
    raw_value = re.sub(r"\b(am|pm)\b", lambda item: item.group(1).upper(), raw_value)

    try:
        parsed = datetime.strptime(raw_value, "%d %B %Y, %I:%M %p")
    except ValueError:
        return None

    return parsed.replace(tzinfo=SGT)


def normalize_status(capacity_percentage: int | None, is_closed: bool | None, badge_text: str) -> str:
    if is_closed:
        return "closed"
    if capacity_percentage is None:
        if "closed" in badge_text.lower():
            return "closed"
        if "not available" in badge_text.lower():
            return "not_available"
        return "unknown"
    return "open"


def reading_from_api(payload: dict[str, Any]) -> CapacityReading | None:
    capacity_payload = find_capacity_payload(payload)
    if not capacity_payload:
        return None

    facilities = capacity_payload.get("gymFacilities", [])
    facility = next(
        (
            item
            for item in facilities
            if isinstance(item, dict)
            and str(item.get("name", "")).casefold() == FACILITY_NAME.casefold()
        ),
        None,
    )
    if not facility:
        return None

    raw_percentage = facility.get("capacityPercentage")
    capacity_percentage = int(raw_percentage) if isinstance(raw_percentage, (int, float)) else None
    is_closed = bool(facility.get("isClosed"))

    if is_closed:
        badge_text = "Closed"
    elif capacity_percentage is None:
        badge_text = "Not available"
    else:
        badge_text = f"{capacity_percentage}% full"

    status = normalize_status(capacity_percentage, is_closed, badge_text)
    source_updated_at = None
    timestamp = capacity_payload.get("timestamp")
    if isinstance(timestamp, str):
        try:
            source_updated_at = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(SGT)
        except ValueError:
            source_updated_at = None

    return CapacityReading(
        scraped_at=isoformat(utc_now()),
        source_updated_at=isoformat(source_updated_at),
        facility=str(facility.get("name") or FACILITY_NAME),
        status=status,
        capacity_percentage="" if status != "open" or capacity_percentage is None else str(capacity_percentage),
        badge_text=badge_text,
        raw_text=json.dumps(facility, ensure_ascii=True, separators=(",", ":")),
        source="api_response",
    )


def source_updated_at_from_dom(page: Any) -> datetime | None:
    updated_text = page.evaluate(
        """
        () => {
          const updatedNode = Array.from(document.querySelectorAll('p, span')).find((node) => {
            return (node.textContent || '').trim().startsWith('Last updated at');
          });
          return updatedNode ? (updatedNode.textContent || '').trim() : '';
        }
        """
    )
    return parse_source_updated_at(str(updated_text or ""))


def reading_from_dom(page: Any) -> CapacityReading:
    dom_result = page.evaluate(
        """
        (facilityName) => {
          const nameNode = Array.from(document.querySelectorAll('p')).find((node) => {
            return (node.textContent || '').trim().toLowerCase() === facilityName.toLowerCase();
          });

          if (!nameNode) {
            return null;
          }

          const card = nameNode.closest('.chakra-card') || nameNode.parentElement;
          const badgeNode = card ? Array.from(card.querySelectorAll('span')).find((node) => {
            return (node.textContent || '').trim().length > 0;
          }) : null;
          const updatedNode = Array.from(document.querySelectorAll('p, span')).find((node) => {
            return (node.textContent || '').trim().startsWith('Last updated at');
          });

          return {
            facility: (nameNode.textContent || '').trim(),
            badgeText: badgeNode ? (badgeNode.textContent || '').trim() : '',
            rawText: card ? (card.textContent || '').replace(/\\s+/g, ' ').trim() : '',
            updatedText: updatedNode ? (updatedNode.textContent || '').trim() : ''
          };
        }
        """,
        FACILITY_NAME,
    )

    if not dom_result:
        raise RuntimeError(f"Could not find {FACILITY_NAME} in the rendered page")

    raw_text = str(dom_result.get("rawText") or "")
    badge_text = str(dom_result.get("badgeText") or "")
    search_text = f"{badge_text} {raw_text}"
    percent_match = re.search(r"(\d{1,3})\s*%\s*full", search_text, flags=re.IGNORECASE)
    capacity_percentage = int(percent_match.group(1)) if percent_match else None
    source_updated_at = parse_source_updated_at(str(dom_result.get("updatedText") or ""))

    return CapacityReading(
        scraped_at=isoformat(utc_now()),
        source_updated_at=isoformat(source_updated_at),
        facility=str(dom_result.get("facility") or FACILITY_NAME),
        status=normalize_status(capacity_percentage, None, badge_text or raw_text),
        capacity_percentage="" if capacity_percentage is None else str(capacity_percentage),
        badge_text=badge_text,
        raw_text=raw_text,
        source="rendered_dom",
    )


def scrape_capacity(headless: bool = True) -> CapacityReading:
    api_payloads: list[dict[str, Any]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        context = browser.new_context(
            locale="en-SG",
            timezone_id="Asia/Singapore",
            viewport={"width": 1280, "height": 900},
        )
        page = context.new_page()

        def capture_response(response: Any) -> None:
            if API_FRAGMENT not in response.url or response.status != 200:
                return
            try:
                api_payloads.append(response.json())
            except Exception:
                return

        page.on("response", capture_response)
        page.goto(SOURCE_URL, wait_until="domcontentloaded", timeout=90_000)

        try:
            page.get_by_text(FACILITY_NAME, exact=True).wait_for(timeout=90_000)
        except PlaywrightTimeoutError as error:
            title = page.title()
            body_text = page.locator("body").inner_text(timeout=5_000)
            raise RuntimeError(f"ActiveSG page did not render facility list. Title={title!r}; body={body_text[:300]!r}") from error

        page.wait_for_timeout(1_000)

        for payload in reversed(api_payloads):
            reading = reading_from_api(payload)
            if reading:
                if not reading.source_updated_at:
                    reading.source_updated_at = isoformat(source_updated_at_from_dom(page))
                browser.close()
                return reading

        reading = reading_from_dom(page)
        browser.close()
        return reading


def append_reading(reading: CapacityReading) -> None:
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    file_exists = CSV_PATH.exists()
    fieldnames = list(asdict(reading).keys())

    with CSV_PATH.open("a", newline="", encoding="utf-8") as output_file:
        writer = csv.DictWriter(output_file, fieldnames=fieldnames)
        if not file_exists:
            writer.writeheader()
        writer.writerow(asdict(reading))

    LATEST_JSON_PATH.write_text(
        json.dumps(
            {
                "generated_at": isoformat(utc_now()),
                "source_url": SOURCE_URL,
                "reading": asdict(reading),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def error_reading(message: str) -> CapacityReading:
    return CapacityReading(
        scraped_at=isoformat(utc_now()),
        source_updated_at="",
        facility=FACILITY_NAME,
        status="error",
        capacity_percentage="",
        badge_text="Error",
        raw_text=message[:500],
        source="scraper_error",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape ActiveSG Clementi gym crowd data.")
    parser.add_argument("--headed", action="store_true", help="Run Chromium headed for local debugging.")
    parser.add_argument(
        "--record-error",
        action="store_true",
        help="Append an error row instead of failing when the scrape cannot complete.",
    )
    args = parser.parse_args()

    try:
        reading = scrape_capacity(headless=not args.headed)
    except Exception as error:
        if not args.record_error:
            raise
        reading = error_reading(str(error))

    append_reading(reading)
    print(json.dumps(asdict(reading), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
