import CoreGraphics
import Foundation
let a = CommandLine.arguments
func bounds(_ owner: String) -> (Int, CGRect)? {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in list where (w[kCGWindowOwnerName as String] as? String ?? "").contains(owner) && (w[kCGWindowLayer as String] as? Int ?? 1) == 0 {
    let b = w[kCGWindowBounds as String] as! [String: CGFloat]
    return (w[kCGWindowNumber as String] as! Int, CGRect(x: b["X"]!, y: b["Y"]!, width: b["Width"]!, height: b["Height"]!))
  }
  return nil
}
let src = CGEventSource(stateID: .hidSystemState)
switch a[1] {
case "bounds":
  if let (id, r) = bounds(a[2]) { print(id, Int(r.minX), Int(r.minY), Int(r.width), Int(r.height)) }
case "click": // click <owner> <relX> <relY>  (points relative to window)
  guard let (_, r) = bounds(a[2]) else { print("no window"); exit(1) }
  let p = CGPoint(x: r.minX + CGFloat(Double(a[3])!), y: r.minY + CGFloat(Double(a[4])!))
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(80_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(60_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  print("clicked", Int(p.x), Int(p.y))
case "type":
  for ch in a[2].utf16 {
    var c = ch
    let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!; d.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c); d.post(tap: .cghidEventTap)
    let u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!; u.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c); u.post(tap: .cghidEventTap)
    usleep(8_000)
  }
  print("typed")
default: print("usage")
}
