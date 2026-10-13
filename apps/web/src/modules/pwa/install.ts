/** iOS Safari has no `beforeinstallprompt`, so it needs a manual "Add to Home Screen" hint. */
export function isIosDevice(userAgent: string): boolean {
  return /iPad|iPhone|iPod/.test(userAgent);
}

export function isStandaloneDisplay(displayModeStandalone: boolean, navigatorStandalone?: boolean): boolean {
  return displayModeStandalone || navigatorStandalone === true;
}
