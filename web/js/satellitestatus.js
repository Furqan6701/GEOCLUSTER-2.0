/**
 * The "Satellite" status chip in the top bar.
 *
 * The chip is green ("ready") only after a satellite fetch has actually
 * succeeded in this session. Before that it is neutral ("not fetched yet"),
 * and after a failed fetch it is red. "not configured" (no Copernicus
 * credentials on the server) stays amber, because nothing can be fetched.
 *
 * Pure function: no DOM, so the rules are covered by web/tests/logic.test.mjs.
 */

export const SATELLITE_STATUS = Object.freeze({
  IDLE: "idle",
  OK: "ok",
  FAILED: "failed",
});

/**
 * @param {object|null} health   the GET /health payload (null until fetched)
 * @param {{status: string}|null} satellite  the outcome of the last fetch
 * @returns {{label: string, kind: string, title: string}}
 */
export function satelliteChip(health, satellite) {
  if (!health?.satellite_configured) {
    return {
      label: "Satellite not configured",
      kind: "warn",
      title: "Copernicus credentials are not set on the server",
    };
  }
  const status = satellite?.status ?? SATELLITE_STATUS.IDLE;
  if (status === SATELLITE_STATUS.OK) {
    return {
      label: "Satellite ready",
      kind: "ok",
      title: "The last satellite fetch succeeded",
    };
  }
  if (status === SATELLITE_STATUS.FAILED) {
    return {
      label: "Satellite fetch failed",
      kind: "bad",
      title: "The last satellite fetch failed. Check the message shown in the page, then try again",
    };
  }
  return {
    label: "Satellite not fetched yet",
    kind: "",
    title: "Fetch a Sentinel-2 crop to confirm the satellite connection",
  };
}
