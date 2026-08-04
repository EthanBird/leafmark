# LeafMark Native Android

LeafMark Android uses the experimental Dioxus Native renderer (`native` renderer / Blitz / WGPU), not the system WebView renderer.

## Storage

The Android build resolves application directories through JNI:

- configuration and retained data: `Context.getFilesDir()`
- cache: `Context.getCacheDir()`
- workspace: `Context.getExternalFilesDir(null)/LeafMark`

The workspace is app-specific external storage. It does not require broad storage permission and is removed when the application is uninstalled. A later SAF integration will allow users to select arbitrary document trees.

## Current target

- Android arm64-v8a
- APK artifact for direct testing
- Dioxus 0.7.9 native renderer
- Rust `aarch64-linux-android` target

The Android build is considered experimental until physical-device tests cover IME composition, selection, clipboard, lifecycle restoration, Vulkan fallback, and large Markdown documents.
