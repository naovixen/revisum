() => {
  // Counts its own runs on the page, so a test can show whether the script ran at all.
  window.scriptRuns = (window.scriptRuns ?? 0) + 1;
  document.querySelector('[data-testid="script-runs"]').textContent = String(window.scriptRuns);
  return { runs: window.scriptRuns };
}
