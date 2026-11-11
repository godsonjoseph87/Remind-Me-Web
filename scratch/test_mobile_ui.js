const fs = require("fs");
const path = require("path");

const htmlPath = path.join(__dirname, "../public/index.html");
const cssPath = path.join(__dirname, "../public/styles.css");
const jsPath = path.join(__dirname, "../public/app.js");
const manifestPath = path.join(__dirname, "../public/manifest.json");

console.log("Checking file existence...");
if (!fs.existsSync(htmlPath)) throw new Error("index.html missing");
if (!fs.existsSync(cssPath)) throw new Error("styles.css missing");
if (!fs.existsSync(jsPath)) throw new Error("app.js missing");
if (!fs.existsSync(manifestPath)) throw new Error("manifest.json missing");
console.log("✓ All key files exist.");

const html = fs.readFileSync(htmlPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

console.log("Validating Manifest...");
if (!manifest.name || !manifest.name.includes("RemindMe")) throw new Error("Manifest name invalid");
if (manifest.display !== "standalone") throw new Error("Manifest display should be standalone");
console.log("✓ manifest.json is valid.");

console.log("Validating HTML elements...");
const requiredElements = [
  "mobile-header",
  "mobile-brand-link",
  "m-btn-theme",
  "m-btn-audio",
  "m-btn-notifications",
  "mobile-user-slot",
  "mobile-dashboard",
  "greeting-time",
  "greeting-name",
  "m-stat-active",
  "m-stat-snoozed",
  "m-stat-total",
  "m-card-active",
  "m-card-snoozed",
  "m-card-total",
  "fab-new-reminder",
  "mobile-bottom-nav",
  "bnav-list",
  "bnav-calendar",
  "bnav-google",
  "bnav-settings",
  "settings-modal-overlay",
  "settings-modal-close",
  "settings-modal-done",
  "btn-settings-audio",
  "btn-settings-notifications",
  "btn-settings-theme",
  "btn-settings-open-guide"
];

for (const id of requiredElements) {
  if (!html.includes(`id="${id}"`)) {
    throw new Error(`Missing required element id="${id}" in index.html`);
  }
}
console.log(`✓ All ${requiredElements.length} mobile element IDs verified in index.html.`);

console.log("Validating JavaScript mobile handlers...");
const requiredFunctions = [
  "updateGreeting",
  "syncBottomNav",
  "openSettingsModal",
  "closeSettingsModal",
  "syncSettingsModalState",
  "updateAudioUI",
  "toggleAudio",
  "updateNotificationUI",
  "requestAppNotifications"
];

for (const fn of requiredFunctions) {
  if (!js.includes(`function ${fn}`)) {
    throw new Error(`Missing function ${fn} in app.js`);
  }
}
console.log(`✓ All ${requiredFunctions.length} mobile functions verified in app.js.`);

console.log("Validating CSS Mobile Rules...");
const requiredCssClasses = [
  ".mobile-header",
  ".mobile-dashboard",
  ".mobile-bottom-nav",
  ".mobile-fab",
  ".sheet-drag-handle",
  "@media (max-width: 768px)",
  "@media (max-width: 480px)",
  "@media (max-width: 360px)",
  "sheetSlideUp",
  "env(safe-area-inset-bottom"
];

for (const sel of requiredCssClasses) {
  if (!css.includes(sel)) {
    throw new Error(`Missing CSS rule/selector "${sel}" in styles.css`);
  }
}
console.log(`✓ All ${requiredCssClasses.length} CSS rules verified in styles.css.`);

console.log("\nALL VERIFICATIONS PASSED SUCCESSFULLY! 🚀");
