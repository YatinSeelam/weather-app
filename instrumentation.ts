export async function register() {
  // The scheduler needs Node APIs (timers that outlive a request, the filesystem store).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startMonitorScheduler } = await import("@/lib/weather/monitor-scheduler");
  startMonitorScheduler();
}
