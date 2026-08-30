(() => {
  function addPicksLink() {
    document.querySelectorAll(".top nav").forEach((nav) => {
      if (nav.querySelector("[data-early-late-picks]")) return;
      const link = document.createElement("a");
      link.className = "nav";
      link.href = "/picks.html";
      link.textContent = "Early + Late Picks";
      link.dataset.earlyLatePicks = "true";
      nav.appendChild(link);
    });
  }

  addPicksLink();
  const observer = new MutationObserver(addPicksLink);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
