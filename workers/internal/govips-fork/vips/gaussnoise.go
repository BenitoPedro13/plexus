package vips

// NewGaussnoiseImage generates a single-band Gaussian-noise image of the
// given size — libvips' documented noise-synthesis primitive
// (vips_gaussnoise, "make a gaussnoise image"). Not exported by
// github.com/davidbyttow/govips/v2 as of v2.18.0 (the latest release —
// V-8, docs/90-deferred-register.md): vipsGenGaussnoise exists in
// generated.go but has no (*ImageRef) wrapper, and — like tonelut.go's
// Tonelut — gaussnoise takes no input image, so a wrapper outside this
// package can't construct the resulting *ImageRef: ImageRef.image and
// newImageRef are both unexported. Hence this file lives in a local fork
// of the vips package itself, mirroring tonelut.go's shape exactly (D-24's
// precedent, applied to a second missing wrapper per D-28).
//
// GaussnoiseOptions.Mean defaults to libvips' own default (128, confirmed
// via `vips gaussnoise --help` against libvips 8.18.5) when left nil —
// callers building zero-centered additive noise (e.g.
// workers/internal/processors/black_and_white.go's grain param) must pass
// Mean explicitly as 0, not rely on the generator's default.
func NewGaussnoiseImage(width, height int, opts *GaussnoiseOptions) (*ImageRef, error) {
	out, err := vipsGenGaussnoise(width, height, opts)
	if err != nil {
		return nil, err
	}
	return newImageRef(out, ImageTypeUnknown, ImageTypeUnknown, nil), nil
}
