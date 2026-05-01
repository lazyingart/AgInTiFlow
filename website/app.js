const copyButtons = [...document.querySelectorAll("[data-copy-target]")];
const feedback = document.querySelector("#copy-feedback");

function setFeedback(message) {
  feedback.textContent = message;
  window.clearTimeout(setFeedback.timer);
  setFeedback.timer = window.setTimeout(() => {
    feedback.textContent = "";
  }, 1800);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for restricted local previews and some automated browsers.
    }
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const target = document.querySelector(`#${button.dataset.copyTarget}`);
    const text = target?.textContent?.trim();
    if (!text) return;
    try {
      await copyText(text);
      setFeedback(`Copied: ${text}`);
    } catch {
      setFeedback("Copy failed. Select the command and copy it manually.");
    }
  });
}

const slides = [...document.querySelectorAll(".carousel-slide")];
const dots = document.querySelector(".carousel-dots");
let activeIndex = 0;

function renderCarousel() {
  slides.forEach((slide, index) => {
    slide.classList.toggle("active", index === activeIndex);
    slide.classList.toggle("previous-slide", index === (activeIndex - 1 + slides.length) % slides.length);
    slide.classList.toggle("next-slide", index === (activeIndex + 1) % slides.length);
    slide.setAttribute("aria-hidden", index === activeIndex ? "false" : "true");
  });

  [...dots.children].forEach((dot, index) => {
    dot.setAttribute("aria-current", index === activeIndex ? "true" : "false");
  });
}

function goToSlide(index) {
  activeIndex = (index + slides.length) % slides.length;
  renderCarousel();
}

slides.forEach((slide, index) => {
  const dot = document.createElement("button");
  dot.type = "button";
  dot.setAttribute("aria-label", `Show screenshot ${index + 1}`);
  dot.addEventListener("click", () => goToSlide(index));
  dots.append(dot);
});

document.querySelector("[data-carousel-prev]").addEventListener("click", () => goToSlide(activeIndex - 1));
document.querySelector("[data-carousel-next]").addEventListener("click", () => goToSlide(activeIndex + 1));

document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") goToSlide(activeIndex - 1);
  if (event.key === "ArrowRight") goToSlide(activeIndex + 1);
});

renderCarousel();
