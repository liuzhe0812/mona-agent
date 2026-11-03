# FFmpeg 6.1.1 runtime sources

The two license files in this directory are unchanged bytes from FFmpeg's `n6.1.1` tag:

- [`LICENSE.md`](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n6.1.1/LICENSE.md): 4,376 bytes; SHA-256 `cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2`.
- [`COPYING.GPLv2`](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n6.1.1/COPYING.GPLv2): 18,092 bytes; SHA-256 `8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643`.

The macOS FFmpeg and FFprobe archives are published by Martin Riedl:

- [Apple Silicon build, 21 February 2024](https://ffmpeg.martin-riedl.de/info/detail/macos/arm64/1708546399_6.1.1), with [build configuration and library versions](https://ffmpeg.martin-riedl.de/download/macos/arm64/1708546399_6.1.1/versions.txt).
- [Intel build, 21 February 2024](https://ffmpeg.martin-riedl.de/info/detail/macos/amd64/1708548944_6.1.1), with [build configuration and library versions](https://ffmpeg.martin-riedl.de/download/macos/amd64/1708548944_6.1.1/versions.txt).

Both published configurations enable GPL and libx264; neither lists `--enable-version3` or `--enable-nonfree`. The executables include third-party libraries listed in the build details, whose notices and source availability must also be considered when distributing these binaries.
