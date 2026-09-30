// Emit the screen geometry of the System Settings main window so the CUA permission floating window can snap to it.
//
// Why this standalone binary: snapping needs exactly one piece of data - the bounds of the System Settings window. The right API is
// CGWindowListCopyWindowInfo, and it **requires no TCC permission at all** (only capturing a window *image* needs Screen
// Recording). This is the premise the whole approach rests on: at authorization-onboarding time we have neither Accessibility nor Screen Recording permission yet.
// Electron has no binding for this API and every other route is a dead end - osascript + System Events needs the Accessibility
// permission (a deadlock), desktopCapturer only gives window names, not bounds, and FFI like koffi is itself a native addon
// that needs electron-rebuild. So we use a command-line program under 100KB with no bundle.
//
// Long-running design: emit one JSON line per interval. The parent spawns once and reads stdout - starting a new process every frame
// (~10ms × 7 times per second) would be completely unacceptable.
//
// Usage: zcode-window-bounds [intervalMs]   default 150ms

import CoreGraphics
import Foundation

let intervalMs = UInt32(CommandLine.arguments.dropFirst().first.flatMap { UInt32($0) } ?? 150)
// The settings app's process name differs across macOS versions and locales: on 13+ it is "System Settings", earlier it is
// "System Preferences", and on Chinese systems it is the localized name.
let settingsOwners = ["System Settings", "System Preferences", "系统设置", "系統設定"]

// Line buffering: the parent reads line by line; the default full buffering would strand data in the stdio buffer until 4KB accumulates.
setvbuf(stdout, nil, _IOLBF, 0)

while true {
    var windows: [[String: Any]] = []

    if let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] {
        for window in list {
            guard let owner = window[kCGWindowOwnerName as String] as? String,
                settingsOwners.contains(where: { owner.contains($0) }),
                let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
                let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { continue }

            windows.append([
                "x": rect.origin.x,
                "y": rect.origin.y,
                "w": rect.size.width,
                "h": rect.size.height,
                // Consumers only honor layer 0 (normal windows). Settings pages also emit auxiliary layers above layer 0
                // (tooltips, popup pickers); snapping to those would fling the panel into a screen corner.
                "layer": window[kCGWindowLayer as String] as? Int ?? -1,
            ])
        }
    }

    // Even with no matching window, still emit an empty array: the parent uses it to tell "the settings page is closed" from "the probe is stuck".
    if let data = try? JSONSerialization.data(withJSONObject: windows),
        let line = String(data: data, encoding: .utf8)
    {
        print(line)
    }

    usleep(intervalMs * 1000)
}
