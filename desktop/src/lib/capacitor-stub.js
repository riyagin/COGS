// Stand-in for the @capacitor/* packages the shared API client lazily imports for Android
// downloads. The desktop app is never a native mobile platform, so they are never used.
export const Capacitor = { isNativePlatform: () => false }
export const Filesystem = null
export const Directory = {}
export const Share = null
