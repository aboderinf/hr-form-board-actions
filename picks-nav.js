(() => {
  function addPicksLinks() {
    document.querySelectorAll(".top nav").forEach((nav) => {
      if (!nav.querySelector("[data-early-late-picks]")) {
        const link = document.createElement("a");
        link.className = "nav";
        link.href = "/picks.html";
        link.textContent = "Early + Late Picks";
        link.dataset.earlyLatePicks = "true";
        nav.appendChild(link);
      }
      if (!nav.querySelector("[data-recent-hr-rule]")) {
        const link = document.createElement("a");
        link.className = "nav";
        link.href = "/recent-hr-rule.html";
        link.textContent = "Recent HR Rule";
        link.dataset.recentHrRule = "true";
        nav.appendChild(link);
      }
    });
  }

  addPicksLinks();
  const observer = new MutationObserver(addPicksLinks);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
