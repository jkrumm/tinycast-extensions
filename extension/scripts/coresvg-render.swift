// Renders an SVG through macOS' own decoder (`NSImage(data:)`, CoreSVG) — the
// same one Tinycast uses — after the same whole-name `raycast-*` rewrite
// Tinycast's `ExtensionIconCache.rewritingNames` does. Used by
// scripts/chart-previews.ts `--coresvg`; the palette must stay in sync with it.
//
//   coresvg-render <in.svg> <dark|light> <out.png> [scale]
import AppKit

let args = CommandLine.arguments
guard args.count >= 4 else {
    FileHandle.standardError.write(Data("usage: coresvg-render <in.svg> <dark|light> <out.png> [scale]\n".utf8))
    exit(2)
}
let dark = args[2] == "dark"
let scale = args.count > 4 ? CGFloat(Double(args[4]) ?? 2) : 2

let palette: [String: String] = dark
    ? [
        "raycast-blue": "rgba(0,145,255,1.0)", "raycast-green": "rgba(48,209,88,1.0)",
        "raycast-magenta": "rgba(217,61,158,1.0)", "raycast-orange": "rgba(255,146,48,1.0)",
        "raycast-purple": "rgba(219,52,242,1.0)", "raycast-red": "rgba(255,66,69,1.0)",
        "raycast-yellow": "rgba(255,214,0,1.0)", "raycast-primary-text": "rgba(255,255,255,0.847)",
        "raycast-secondary-text": "rgba(255,255,255,0.6)",
    ]
    : [
        "raycast-blue": "rgba(0,136,255,1.0)", "raycast-green": "rgba(52,199,89,1.0)",
        "raycast-magenta": "rgba(217,61,158,1.0)", "raycast-orange": "rgba(255,141,40,1.0)",
        "raycast-purple": "rgba(203,48,224,1.0)", "raycast-red": "rgba(255,56,60,1.0)",
        "raycast-yellow": "rgba(255,204,0,1.0)", "raycast-primary-text": "rgba(0,0,0,0.847)",
        "raycast-secondary-text": "rgba(0,0,0,0.6)",
    ]

let source = try String(contentsOfFile: args[1], encoding: .utf8)
var rewritten = ""
var rest = Substring(source)
let nameCharacters = Set("abcdefghijklmnopqrstuvwxyz-")
while let match = rest.range(of: "raycast-", options: .literal) {
    let name = rest[match.lowerBound...].prefix { nameCharacters.contains($0) }
    rewritten += rest[..<match.lowerBound]
    rewritten += palette[String(name)] ?? String(name)
    rest = rest[name.endIndex...]
}
rewritten += rest

guard let image = NSImage(data: Data(rewritten.utf8)) else {
    FileHandle.standardError.write(Data("NSImage could not decode the SVG\n".utf8))
    exit(1)
}
let width = Int(image.size.width * scale)
let height = Int(image.size.height * scale)
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0
) else { exit(1) }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
(dark ? NSColor(red: 0.118, green: 0.118, blue: 0.118, alpha: 1) : NSColor.white).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[3]))
