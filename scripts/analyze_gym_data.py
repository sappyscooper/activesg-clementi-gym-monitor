from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


DEFAULT_CSV = Path("public/data/clementi_gym_capacity.csv")


def analyze_gym_data(csv_file: Path = DEFAULT_CSV) -> None:
    df = pd.read_csv(csv_file)
    df = df[df["status"] == "open"].copy()
    df["capacity_percentage"] = pd.to_numeric(df["capacity_percentage"], errors="coerce")
    df = df.dropna(subset=["capacity_percentage"])

    if df.empty:
        print("No open-hour capacity rows available yet.")
        return

    df["observed_at"] = pd.to_datetime(df["source_updated_at"].fillna(df["scraped_at"]), utc=True)
    df["observed_sgt"] = df["observed_at"].dt.tz_convert("Asia/Singapore")
    df["Hour"] = df["observed_sgt"].dt.hour
    df["DayOfWeek"] = df["observed_sgt"].dt.day_name()

    days_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    df["DayOfWeek"] = pd.Categorical(df["DayOfWeek"], categories=days_order, ordered=True)

    heatmap_data = df.groupby(["DayOfWeek", "Hour"], observed=True)["capacity_percentage"].mean().unstack()
    hourly_avg = df.groupby("Hour")["capacity_percentage"].mean()
    peak_hour = hourly_avg.idxmax()
    quiet_hour = hourly_avg.idxmin()

    print(f"Overall peak hour: {peak_hour}:00 with average capacity {hourly_avg.max():.2f}%")
    print(f"Overall quietest hour: {quiet_hour}:00 with average capacity {hourly_avg.min():.2f}%")

    plt.figure(figsize=(14, 8))
    sns.heatmap(heatmap_data, cmap="YlOrRd", annot=True, fmt=".0f", linewidths=0.5)
    plt.title("ActiveSG Clementi Gym Crowd Heatmap")
    plt.xlabel("Hour of Day (SGT)")
    plt.ylabel("Day of Week")
    plt.tight_layout()
    plt.savefig("clementi_gym_heatmap.png", dpi=160)


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze Clementi gym capacity data.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    args = parser.parse_args()
    analyze_gym_data(args.csv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
