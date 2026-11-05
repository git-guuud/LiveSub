export const LOCK_TEXT = "MIC LOCKED: ENCLAVE OFFLINE";

export const FACE_LABEL = {
  companion: "Companion",
  live: "Live",
  not_linked: "Not linked",
  locked: LOCK_TEXT,
};

const REASONS = {
  phone_closed: "Live needs the phone page.",
  locked: "The mic is locked.",
  not_linked: "The relay link is down.",
  one_chunk: "Only one clip at a time.",
  empty_chunk: "Empty clip dropped.",
  chunk_too_large: "That clip is too long.",
  bad_message: "The relay ignored that message.",
};

export function reasonText(reason) {
  return REASONS[reason] ?? "The relay refused that.";
}

export function renderGlass(glass, state) {
  const face = state?.face;
  const locked = face === "locked";
  glass.classList.toggle("is-locked", locked);
  glass.replaceChildren();
  const label = document.createElement("p");
  label.className = "face";
  label.textContent = FACE_LABEL[face] ?? FACE_LABEL.not_linked;
  glass.append(label);
}
