# Compressor

A small, local media converter with a browser UI. Compare the original against several compression settings, inspect the same detail at the same scale, then export the version you want. Media processing runs on your machine with FFmpeg and Sharp; files are not sent to a cloud service.

## Run

Install Node.js 22 or newer, pnpm, and FFmpeg with ffprobe. On macOS, install FFmpeg with `brew install ffmpeg`.

```sh
git clone https://github.com/jonahclarsen/compressor.git
cd compressor
pnpm install
pnpm dev
```

Open the URL printed in the terminal. The server binds to `127.0.0.1` and chooses an available port using cryptographic randomness on its first launch. That port is saved in the git-ignored `.compressor-port` file and reused on every restart. If it is occupied, startup reports an error instead of switching ports. Delete `.compressor-port` only if you want to choose a new random port. Stop it with Ctrl+C.

The FFmpeg build needs `libvpx-vp9`, `libsvtav1`, `libx264`, `libx265`, `libmp3lame`, and `libopus` encoders. Check your installation with `ffmpeg -encoders`.

## Formats

| Input | Output | Controls |
| --- | --- | --- |
| Image | JPEG, WebP | Quality, proportional resolution |
| Video | VP9 / AV1 WebM, HEVC / AVC MP4 | Bitrate, proportional resolution |
| Audio | MP3, Opus | Bitrate |

PNG is supported as an input, but is not an export option. Other inputs depend on the decoders in Sharp and your FFmpeg installation. Multi-page images use the first page/frame. Audio starts at MP3, 256 kbps.

## Compare

Drop a file onto the page or click **Drop a file**. The original appears on the left, followed by three image/video variants or one audio variant. Add another variant with **+**, or remove one with **×**. Drop another file anywhere to open it, or click the app name to return to the file picker.

Each variant has independent settings. Bitrate is a draggable slider with the value and `kbps` together. The video bitrate slider uses a logarithmic range from 50 to 100,000 kbps, allowing useful adjustments at both low and high bitrates. Audio snaps to supported bitrates.

The upper previews follow the source's aspect ratio, avoiding added letterboxing. The taller detail windows always show the center at **1× of the original**: one original pixel per CSS pixel. A reduced-resolution output is enlarged to that same original scale, so every window shows the same source region. The crop is fixed, with no hover navigation or zoom controls. High-density displays preserve that CSS-pixel scale.

For video and audio, the slider beside **COMPARE** selects a preview length from 1 to 20 seconds (video defaults to 3; audio to 8). The timeline shows the position in the full source and advances during playback. Seeking inside the loaded interval moves all players immediately; seeking outside it generates a new interval. Changing settings pauses playback while previews are encoded and loaded, then resumes all playable variants together. Drift is corrected during playback, and the loaded interval loops as a group. Audio has a **Listen** button per variant to switch which version you hear without restarting the comparison.

## Previews and sizes

Image previews are complete encoded images. Video and audio previews encode only the selected interval using the same output settings as export. Short intervals keep iteration quick; longer intervals take more time, particularly at high resolutions.

The original image is decoded to PNG for display. The original video reference is a full-resolution, lossless VP9 browser proxy of the selected interval, with Opus audio. The original audio reference is decoded to floating-point PCM at 48 kHz stereo. These references allow previewing formats a browser cannot open directly; they do not replace the source used for exports. Pixel-format conversion, color handling, and audio resampling can still affect the displayed reference.

Browsers vary in codec support, especially HEVC. If a video cannot play directly, the server builds a lossless VP9 playback proxy from the encoded interval, preserving its compression artifacts and allowing synchronized playback. The displayed size and exported file still refer to the selected codec. If proxy playback also fails, the card falls back to an encoded still. Use AVC for broad direct playback compatibility.

The original card shows the source file size. Image cards show the actual output size. Video/audio cards show an **estimated full-file size**, prefixed with `~`, extrapolated from the encoded preview. Hover the number for its meaning. Export replaces the estimate with the measured full output size. Estimates can vary substantially with scene complexity, encoder startup, and container overhead.

## Export

Click **Export** on a variant to convert the entire source and download the result. Preview position and length do not trim the export. Progress and cancellation are available while it runs.

Video audio is encoded as stereo AAC for MP4 or stereo Opus for WebM, at 128 kbps. JPEG transparency is flattened onto white. Resolution controls preserve aspect ratio; video dimensions are even and respect encoder minimum sizes. Preview and full-export results can differ slightly because temporal codecs start with a fresh rate-control window for each interval.

## Local storage

Uploads, browser references, previews, and exports live in a temporary directory for the server session. They are removed on graceful shutdown. Force-killing the process can leave that temporary directory behind. Repeated settings reuse cached previews; obsolete preview requests are cancelled, and conversion concurrency is limited to two jobs.

## Tests

```sh
pnpm test
```

The integration suite generates media fixtures and tests all output formats, full exports, original references, preview duration and seeking, resizing, validation, and origin checks.

For browser tests, install Chromium once and start the app:

```sh
pnpm exec playwright install chromium
pnpm dev
```

In another terminal, use the URL printed by the app:

```sh
APP_URL=http://127.0.0.1:YOUR_PORT node test/browser.mjs
```

Browser checks cover the original column, fixed detail crop, bitrate sliders, downloads, mobile layout, synchronized seeking and looping, and deliberately delayed preview responses.

Built with [FFmpeg](https://ffmpeg.org/ffmpeg.html), [Sharp](https://sharp.pixelplumbing.com/), Express, and plain browser JavaScript.
