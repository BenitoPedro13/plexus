// Local fork of github.com/davidbyttow/govips/v2's `vips` package (v2.18.0
// base), patched to add the Tonelut/MaplutBand wrappers V-7 in
// docs/90-deferred-register.md found missing upstream. See
// docs/tasks/TASK-highlights-shadows-tonelut.md for why this exists and
// TASK-recipe-fidelity-drift.md-style re-evaluation note in the deferred
// register for when to drop it (a future govips release exporting Tonelut).
//
// Only the vips/ package itself is vendored here (not resources/, assets/,
// examples/, cmd/, or *_test.go — none of those are needed to build this
// fork as a replace target).
module github.com/davidbyttow/govips/v2

go 1.26.5

require (
	golang.org/x/image v0.38.0
	golang.org/x/net v0.52.0
)

require golang.org/x/text v0.35.0 // indirect
