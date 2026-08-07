package vips

// Tonelut generates a tone-curve LUT image for adjusting L*-channel levels
// (0-100 scale, quantized into opts.InMax+1 entries) — libvips' documented
// shadows/highlights recovery primitive, normally reached via
// tonelut->maplut on a LABS image's L band
// (github.com/libvips/libvips/discussions/4036). Not exported by
// github.com/davidbyttow/govips/v2 as of v2.18.0 (the latest release —
// V-7, docs/90-deferred-register.md): vipsGenTonelut exists in
// generated.go but has no (*ImageRef) wrapper, and — unlike Sharpen/Recomb,
// which mutate an existing r.image — tonelut takes no input image, so a
// wrapper outside this package can't construct the resulting *ImageRef:
// ImageRef.image and newImageRef are both unexported. Hence this file lives
// in a local fork of the vips package itself rather than in workers' own
// processors package.
//
// Deliberately does NOT also add a MaplutOptions.Band-based
// "MaplutBand(lut, band)" convenience (band-limited maplut applied to a
// whole multi-band image): verified experimentally
// (docs/tasks/TASK-highlights-shadows-tonelut.md) that libvips' own
// vips_maplut_build sets the *entire* output image's BandFmt to the LUT's
// BandFmt (maplut.c: "maplut->out->BandFmt = lut->BandFmt"), corrupting the
// untouched bands' format tag even though their byte values pass through
// unaltered — e.g. LABS a/b (signed short, real range roughly -128..127
// scaled to -32768..32767) get relabelled as the LUT's unsigned short
// format, so any later consumer reinterprets negative a/b values as huge
// positive ones. workers/internal/processors/adjust_light.go instead uses
// the already-exported ExtractBandToImage -> Maplut -> BandJoin ->
// CopyChangingInterpretation sequence, which does not have this problem.
func Tonelut(opts *TonelutOptions) (*ImageRef, error) {
	out, err := vipsGenTonelut(opts)
	if err != nil {
		return nil, err
	}
	return newImageRef(out, ImageTypeUnknown, ImageTypeUnknown, nil), nil
}
