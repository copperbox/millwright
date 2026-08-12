/**
 * The synth build's image (spec §7.2): the full `node:22` public-ECR variant
 * (git + node), pinned BY DIGEST per control-plane release. This is
 * millwright pinning a public image, not publishing one; the synth job is
 * explicitly exempt from §11.1's user-job image contract.
 *
 * Refresh the digest at release time with `node scripts/pin-synth-image.mjs`,
 * which resolves the current multi-arch index digest for the tag below.
 */

/** Human-readable tag the digest was resolved from. */
export const SYNTH_IMAGE_TAG = '22';

/** Multi-arch image index digest for `node:{@link SYNTH_IMAGE_TAG}`. */
export const SYNTH_IMAGE_DIGEST =
  'sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a';

/**
 * The image reference CodeBuild pulls. Digest-only form (no tag) so the pull
 * can never drift from what the release pinned.
 */
export const SYNTH_IMAGE = `public.ecr.aws/docker/library/node@${SYNTH_IMAGE_DIGEST}`;
