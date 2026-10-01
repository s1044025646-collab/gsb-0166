/**
 * Public numeric tolerances. All "near zero" decisions in this project
 * must go through these constants; raw values are always retained for
 * display so results are never silently truncated to zero.
 */

/** Relative tolerance for comparing floating point magnitudes. */
export const EPS_REL = 1e-9;

/** Absolute floor used only when a compared quantity is itself ~0. */
export const EPS_ABS = 1e-12;

/**
 * A complex structure factor is treated as extinct when |F| / Fscale is
 * below this threshold, where Fscale is the largest |F| found in the scan.
 * The ratio (not an arbitrary absolute cutoff) makes the rule independent
 * of the scattering-factor magnitudes used.
 */
export const EXTINCTION_REL = 1e-8;

/**
 * Two d-spacings are considered the same powder line when their relative
 * difference is below this value. d values within one scan are derived from
 * identical (a,b,c), so exact-equal groups normally coincide bit-for-bit;
 * the tolerance only guards arithmetic noise.
 */
export const D_MERGE_REL = 1e-9;

/** Report schema/version marker persisted with every scan snapshot. */
export const REPORT_VERSION = 1;

/** Bragg geometry factor: lambda / (2 d) must be <= 1 - this slack. */
export const SIN_THETA_SLACK = 1e-12;
