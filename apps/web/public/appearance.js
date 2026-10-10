// Runs synchronously in <head>, before styles or the renderer can paint.
(() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const normalize = value => value === "light" || value === "dark" ? value : "system";
  let preference = "system";
  try { preference = normalize(localStorage.getItem("openpond:appearance")); } catch { /* Storage can be unavailable in a restricted browser. */ }
  function apply() {
    const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    const changed = root.dataset.theme !== resolved || root.dataset.themePreference !== preference;
    root.dataset.themePreference = preference;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    void window.openpond?.setAppearance?.(preference).catch(error => console.error("Desktop appearance could not be saved", error));
    if (changed) window.dispatchEvent(new Event("openpond:theme-changed"));
  }
  window.addEventListener("openpond:appearance", event => {
    preference = normalize(event.detail);
    apply();
  });
  window.addEventListener("storage", event => {
    if (event.key !== "openpond:appearance" && event.key !== null) return;
    preference = normalize(event.newValue);
    apply();
  });
  media.addEventListener("change", () => { if (preference === "system") apply(); });
  apply();
})();
