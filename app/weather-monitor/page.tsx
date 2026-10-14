import type { Metadata } from "next";
import { WeatherMonitorApp } from "@/components/weather/weather-monitor-app";

export const metadata: Metadata = {
  title: "Weather Monitoring",
};

export default function WeatherMonitorPage() {
  return <WeatherMonitorApp />;
}
