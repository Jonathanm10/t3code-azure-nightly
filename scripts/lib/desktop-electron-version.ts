export const REVIEWED_DESKTOP_ELECTRON_VERSION = "44.4.5";

export function assertReviewedDesktopElectronVersion(version: string | undefined): void {
  if (version !== REVIEWED_DESKTOP_ELECTRON_VERSION) {
    throw new Error(
      `Fork profile isolation requires a reviewed Electron ${REVIEWED_DESKTOP_ELECTRON_VERSION} bootstrap.`,
    );
  }
}
