const directions = [
  ["native", "Native"],
  ["canvas", "Canvas"],
  ["workspace", "Workspace"],
  ["focus", "Focus"],
  ["clarity", "Clarity"],
];

if (new URLSearchParams(window.location.search).has("embed")) {
  document.documentElement.classList.add("embed");
} else {
  const bar = document.querySelector(".review-bar");
  if (bar) {
    const back = document.createElement("a");
    back.href = "../";
    back.className = "review-back";
    back.textContent = "← All five directions";
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Design directions");
    directions.forEach(([slug, name], index) => {
      const link = document.createElement("a");
      link.href = `../${slug}/`;
      link.setAttribute("aria-label", `${index + 1}. ${name}`);
      if (document.body.dataset.direction === slug) link.setAttribute("aria-current", "page");
      const number = document.createElement("span");
      number.textContent = String(index + 1).padStart(2, "0");
      const label = document.createElement("span");
      label.className = "review-name";
      label.textContent = ` ${name}`;
      link.append(number, label);
      nav.append(link);
    });
    const caption = document.createElement("span");
    caption.className = "review-caption";
    caption.textContent = "Crate / Design studies";
    bar.replaceChildren(back, nav, caption);
  }
}

const previews = document.querySelectorAll(".preview");
if (previews.length) {
  const resize = new ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      if (target instanceof HTMLElement) {
        target.style.setProperty("--preview-scale", String(contentRect.width / 1280));
      }
    }
  });
  previews.forEach((preview) => resize.observe(preview));
}

// These controls demonstrate the existing reminder views using local example data.
document.querySelectorAll(".demo-app").forEach((app) => {
  const tabs = Array.from(app.querySelectorAll('[role="tab"]'));
  const selectTab = (selected) => {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.setAttribute("tabindex", active ? "0" : "-1");
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !active;
    }
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      const index = tabs.indexOf(tab);
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      const selected = tabs[next];
      if (selected instanceof HTMLElement) {
        selectTab(selected);
        selected.focus();
      }
    });
  }
  app.addEventListener("change", (event) => {
    const source = event.target;
    if (!(source instanceof HTMLInputElement) || !source.dataset.task) return;
    for (const input of app.querySelectorAll("input[data-task]")) {
      if (input instanceof HTMLInputElement && input.dataset.task === source.dataset.task) {
        input.checked = source.checked;
      }
    }
    for (const view of app.querySelectorAll(".app-view")) {
      const tasks = Array.from(view.querySelectorAll("input[data-task]"));
      if (!tasks.length) continue;
      const remaining = tasks.filter((input) => input instanceof HTMLInputElement && !input.checked).length;
      const count = view.querySelector(".app-count");
      if (count) count.textContent = `${remaining} ${remaining === 1 ? "reminder" : "reminders"}`;
    }
  });
});

const sectionLinks = document.querySelectorAll(".workspace-nav nav a");
if (sectionLinks.length) {
  const updateSection = () => {
    const hash = window.location.hash || "#overview";
    for (const link of sectionLinks) {
      const active = link.getAttribute("href") === hash;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  window.addEventListener("hashchange", updateSection);
  updateSection();
}
