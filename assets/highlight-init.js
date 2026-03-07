(function () {
  function runHighlight(root) {
    if (!window.hljs || !root) return;

    root.querySelectorAll("pre code").forEach((block) => {
      try {
        window.hljs.highlightElement(block);
      } catch (err) {
        console.error("Highlight failed:", err);
      }
    });
  }

  window.runHighlight = runHighlight;

  function boot() {
    const preview = document.getElementById("preview");
    if (preview) runHighlight(preview);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();