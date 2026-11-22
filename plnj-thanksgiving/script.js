import {
  actVariant,
  applyAct,
  authorizationStatus,
  buildReceipt,
  checkpointPassed,
  checkpointTransition,
  completionStatus,
  complication,
  confirmedRec,
  followUp,
  invalidate,
  lensReminder,
  mediaPhasing,
  migrateLegacyState,
  newCheckpoints,
  perMonthSpend,
  protection,
  track,
  submitEvidence,
  validCheckpoints,
} from "./logic.js";

const STORAGE_KEY = "plnj-sim-v1";
const SCREENS = ["S0", "S1", "S2", "S3", "S4", "S5", "S5b", "Q1", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "Q2", "S13", "S14", "S15", "S16", "S17"];
const NODE_KEYS = {
  lens: "R1.1",
  initialRec: "R1.2",
  r13: "R1.3",
  r14: "R1.4",
  r15: "R1.5",
  r15b: "R1.5b",
  r21: "R2.1",
  P: "R2.2",
  cal: "R2.3",
  msg: "R2.4",
  ev: "R2.5",
  r26: "R2.6",
  r31: "R3.1",
  r32: "R3.2",
  defense: "R3.3",
};
const ROUND_MAP = {
  S1: 1, Q1: 1, S2: 1, S3: 1, S4: 1, S5: 1, S5b: 1, S6: 1,
  S7: 2, S8: 2, S9: 2, S10: 2, S11: 2, S12: 2, Q2: 2, S13: 2,
  S14: 3, S15: 3, S16: 3, S17: 3,
};
const SCREEN_DECISION = {
  S1: 1, Q1: 1, S2: 2, S3: 3, S4: 4, S5: 5, S5b: 5, S6: 6,
  S7: 1, S8: 2, S9: 3, S10: 4, S11: 5, S12: 6, Q2: 6, S13: 7,
  S14: 1, S15: 2, S16: 3, S17: 4,
};
const PRIORITIES = ["A", "B", "C", "D"];

const app = document.querySelector("#app");
const screenRegion = document.querySelector("#screen");
let content;
let state = null;
let storageAvailable = true;
let savedRaw = null;
let restoreMessage = "";
let invalidSavedState = false;
let startOverOpen = false;
let otherTabOpen = false;
let showingWelcome = true;
let resetError = "";
let defenseSaveTimer = null;

const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const make = (tag, className = "", text = "") => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = text;
  return element;
};

function showContentError() {
  app.setAttribute("aria-busy", "false");
  screenRegion.replaceChildren();
  const panel = make("section", "error-panel");
  panel.setAttribute("role", "alert");
  panel.append(make("h1", "", content?.ui?.errors?.title ?? "Activity unavailable"));
  panel.append(make("p", "", content?.ui?.errors?.content ?? "The activity could not load its content. Reload this page or open it in a new tab."));
  screenRegion.append(panel);
}

async function loadJson(path) {
  const response = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-cache" });
  if (!response.ok) throw new Error(`Bundled content request failed: ${path}`);
  return response.json();
}

function validateContent(files) {
  const versions = files.map((item) => item?.contentVersion);
  if (files.some((item) => item?.schema !== 1 || typeof item.contentVersion !== "string")) {
    throw new TypeError("Invalid content schema");
  }
  if (new Set(versions).size !== 1) throw new TypeError("Bundled content versions do not match");
  const [choices, cards, ledger, ui] = files;
  const requiredNodes = ["lens", "initialRec", "r13", "r14", "switchReason", "r21", "priorities", "calendar", "message", "evidence", "response", "r31", "r32", "defenseFacts"];
  if (requiredNodes.some((key) => !choices.nodes[key])) throw new TypeError("A required choice node is missing");
  if (Object.keys(cards.stressTests ?? {}).length !== 12) throw new TypeError("Stress-test content is incomplete");
  if (Object.keys(cards.events ?? {}).length !== 3) throw new TypeError("Round 2 event content is incomplete");
  if (Object.keys(cards.followUps ?? {}).length !== 6) throw new TypeError("Follow-up content is incomplete");
  if (Object.keys(cards.complications ?? {}).filter((key) => key.startsWith("C3-")).length !== 6) {
    throw new TypeError("Complication content is incomplete");
  }
  if (Object.values(cards.r31Responses ?? {}).flat().length !== 18) {
    throw new TypeError("Considered-response content is incomplete");
  }
  if (!ledger.tracks || !Number.isFinite(ledger.inputs?.media)
    || !ui.errors?.title || !ui.errors?.content
    || !Array.isArray(ui.ledger?.summaryRows) || !ui.historyLabels) {
    throw new TypeError("Required content is missing");
  }
  const checkpoint = ui.checkpoints;
  const concepts = [...(checkpoint?.round1 ?? []), ...(checkpoint?.round2 ?? [])];
  if (checkpoint?.round1?.length !== 2 || checkpoint?.round2?.length !== 2 || new Set(concepts).size !== 4
    || concepts.some((id) => {
      const item = checkpoint.concepts?.[id];
      return !item?.title || !item.hint || item.variants?.length !== 4
        || item.variants.some((variant) => !variant.prompt || variant.options?.length !== 4
          || new Set(variant.options.map((option) => option.id)).size !== 4
          || new Set(variant.options.map((option) => option.label)).size !== 4
          || variant.options.some((option) => !option.id || !option.label)
          || !variant.options.some((option) => option.id === variant.answer));
    })) throw new TypeError("Evidence checkpoint content is incomplete");
  for (const trackName of ["CUT", "CONS", "TRADE"]) {
    if (!choices.nodes.r21.choicesByTrack[trackName] || !cards.events[trackName]) {
      throw new TypeError(`Missing Round 2 content for ${trackName}`);
    }
  }
}

function stateIsValid(value, legacy = false) {
  if (!(
    value &&
    value.schema === 1 &&
    value.appVersion === content.ui.appVersion &&
    SCREENS.includes(value.screen) &&
    value.answers &&
    typeof value.answers === "object" &&
    Array.isArray(value.history) &&
    value.locks &&
    value.completion
  )) return false;
  if (value.screen === "S0") return false;
  if (!legacy) {
    const definition = content.ui.checkpoints;
    if (!validCheckpoints(value.checkpoints, definition)) return false;
    const position = SCREENS.indexOf(value.screen);
    if (position > SCREENS.indexOf("Q1") && !checkpointPassed(value.checkpoints, definition.round1)) return false;
    if (position > SCREENS.indexOf("Q2") && !checkpointPassed(value.checkpoints, definition.round2)) return false;
    if (value.checkpointReturn) {
      const saved = value.checkpointReturn;
      if (!["Q1", "Q2"].includes(value.screen) || !SCREENS.includes(saved.screen)
        || typeof saved.needsRound2 !== "boolean"
        || (saved.migrated != null && typeof saved.migrated !== "boolean")
        || !stateIsValid({ ...value, screen: saved.screen, draft: saved.draft }, true)) return false;
      if (saved.needsRound2 !== (SCREENS.indexOf(saved.screen) >= SCREENS.indexOf("S13"))) return false;
    }
  }
  const answers = value.answers;
  const hasChoice = (choices, id) => choices.some((item) => item.id === id);
  const allChoices = (node) => Object.values(node.choicesByRecommendation ?? node.choicesByTrack ?? {})
    .flat();
  const validOptional = (id, choices) => id == null || hasChoice(choices, id);
  const initialChoices = content.choices.nodes.initialRec.choices;
  if (answers.r15Evidence != null && typeof answers.r15Evidence !== "string") return false;
  if (!validOptional(answers.lens, content.choices.nodes.lens.choices)
    || !validOptional(answers.initialRec, initialChoices)
    || !validOptional(answers.r13, allChoices(content.choices.nodes.r13))
    || !validOptional(answers.r14, content.choices.nodes.r14.choices)
    || !validOptional(answers.r15, [{ id: "KEEP" }, ...initialChoices.map((item) => ({ id: `SW-${item.id}` }))])
    || !validOptional(answers.r15b, content.choices.nodes.switchReason.choices)
    || !validOptional(answers.r21, allChoices(content.choices.nodes.r21))
    || !validOptional(answers.cal, content.choices.nodes.calendar.choices)
    || !validOptional(answers.msg, content.choices.nodes.message.choices)
    || !validOptional(answers.ev, content.choices.nodes.evidence.choices)
    || !validOptional(answers.r31, Object.values(content.cards.r31Responses).flat())) return false;
  if (answers.defense?.fact && !hasChoice(content.choices.nodes.defenseFacts.choices, answers.defense.fact)) return false;
  if (answers.P != null && (!Array.isArray(answers.P) || answers.P.length !== 2
    || new Set(answers.P).size !== 2
    || answers.P.some((item) => !hasChoice(content.choices.nodes.priorities.choices, item)))) return false;
  if (answers.r15?.startsWith("SW-") && !answers.r15b && value.screen !== "S5b") return false;
  if (answers.r15 === "KEEP" && answers.r15b) return false;
  if (answers.r26 != null) {
    if (!["WATCH", "ACT", "X0"].includes(answers.r26.resp)) return false;
    if (answers.r26.resp === "X0" && !hasChoice(content.cards.followUps.X0.choices, answers.r26.weakLink)) return false;
    if (answers.r26.resp === "ACT" && answers.r26.drop != null
      && !answers.P?.includes(answers.r26.drop)) return false;
  }
  if (answers.r32 != null) {
    if (!hasChoice(content.choices.nodes.r32.choices, answers.r32.action)) return false;
    const plan = {
      rec: confirmedRec(answers),
      P: answers.P ?? [],
      cal: answers.cal,
      msg: answers.msg,
    };
    const authorization = authorizationStatus(answers.r32, plan);
    if (!authorization.valid && !(value.screen === "S16"
      && ["missing", "same", "confirmation"].includes(authorization.reason))) return false;
    if (answers.r32.action.startsWith("REVISE-") && answers.r32.action === `REVISE-${confirmedRec(answers)}`) return false;
    if (answers.r32.action.startsWith("REVISE-") && answers.r32.confirmed !== true && value.screen !== "S16") return false;
  }
  if (answers.defense?.dev && !validDevelopment(answers.defense.dev, value)) return false;
  if (typeof answers.defense?.text !== "string" || wordCount(answers.defense.text) > 150) return false;
  if (value.draft != null && !draftIsValid(value.draft, value)) return false;
  if (typeof value.locks.r1 !== "boolean" || typeof value.locks.r2 !== "boolean" || typeof value.locks.r3 !== "boolean") return false;
  if ((value.locks.r2 && !value.locks.r1) || (value.locks.r3 && !value.locks.r2)) return false;
  const round = ROUND_MAP[value.screen] ?? 0;
  if ((round >= 2 && !value.locks.r1) || (round >= 3 && !value.locks.r2)) return false;
  if (["Q1", "S2"].includes(value.screen) && !answers.lens) return false;
  if (value.screen === "Q2" && (!answers.r15 || !answers.r21 || !answers.P
    || !answers.cal || !answers.msg || !answers.ev || !answers.r26)) return false;
  if (["S3", "S4", "S5", "S5b", "S6"].includes(value.screen) && !answers.initialRec) return false;
  if (["S4", "S5", "S5b", "S6"].includes(value.screen) && !answers.r13) return false;
  if (["S5", "S5b", "S6"].includes(value.screen) && (!answers.r14 || !answers.r14CardViewed)) return false;
  if (["S5b", "S6"].includes(value.screen) && !answers.r15) return false;
  if (value.screen === "S5b" && !answers.r15?.startsWith("SW-")) return false;
  if (["S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "S16", "S17"].includes(value.screen) && !answers.r15) return false;
  if (["S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "S16", "S17"].includes(value.screen) && !answers.r21) return false;
  if (["S9", "S10", "S11", "S12", "S13", "S14", "S15", "S16", "S17"].includes(value.screen) && !answers.P) return false;
  if (["S10", "S11", "S12", "S13", "S14", "S15", "S16", "S17"].includes(value.screen) && !answers.cal) return false;
  if (["S11", "S12", "S13", "S14", "S15", "S16", "S17"].includes(value.screen) && !answers.msg) return false;
  if (["S12", "S13", "S14", "S15", "S16", "S17"].includes(value.screen) && !answers.ev) return false;
  if (["S13", "S14", "S15", "S16", "S17"].includes(value.screen) && !answers.r26) return false;
  if (["S14", "S15", "S16", "S17"].includes(value.screen) && !value.locks.r2) return false;
  if (["S15", "S16", "S17"].includes(value.screen) && !answers.r31) return false;
  if (["S16", "S17"].includes(value.screen) && !answers.r32) return false;
  if (value.screen === "S17" && (!value.locks.r3 || !value.completion.completedAt || !value.completion.receiptIssued)) return false;
  if (value.completion.receipt != null
    && (typeof value.completion.receipt !== "string" || !value.completion.receipt)) return false;
  const validHistoryNodes = new Set([...Object.values(NODE_KEYS), "LOCK-R1", "LOCK-R2"]);
  if (!Array.isArray(value.history) || value.history.some((item, index) =>
    !Number.isInteger(item.seq) || item.seq !== index + 1
      || !validHistoryNodes.has(item.node) || !["active", "superseded"].includes(item.status)
      || typeof item.at !== "string" || Number.isNaN(Date.parse(item.at)))) return false;
  return true;
}

function draftIsValid(draft, value) {
  const screenNode = {
    S1: "lens", S2: "initialRec", S3: "r13", S4: "r14", S5: "r15", S5b: "r15b",
    S7: "r21", S8: "P", S9: "cal", S10: "msg", S11: "ev", S12: "r26",
    S14: "r31", S15: "r32", S16: "defense",
  }[value.screen];
  if (!draft || draft.node !== screenNode || draft.dirty !== true) return false;
  const choices = content.choices.nodes;
  const hasChoice = (list, id) => list.some((item) => item.id === id);
  if (draft.node === "P") {
    return Array.isArray(draft.value) && draft.value.length <= 2
      && new Set(draft.value).size === draft.value.length
      && draft.value.every((id) => hasChoice(choices.priorities.choices, id));
  }
  if (draft.node === "r26") {
    const item = draft.value;
    if (!item || !["WATCH", "ACT", "X0"].includes(item.resp)) return false;
    return item.resp !== "X0" || hasChoice(content.cards.followUps.X0.choices, item.weakLink);
  }
  if (draft.node === "r32") {
    const item = draft.value;
    if (!item || !hasChoice(choices.r32.choices, item.action)) return false;
    if (item.sub == null) return true;
    if (item.action === "REFINE-PRI") {
      return Array.isArray(item.sub) && item.sub.length <= 2
        && new Set(item.sub).size === item.sub.length
        && item.sub.every((id) => hasChoice(choices.priorities.choices, id));
    }
    if (item.action === "REFINE-CAL") return hasChoice(choices.calendar.choices, item.sub);
    if (item.action === "REFINE-MSG") return hasChoice(choices.message.choices, item.sub);
    return item.sub == null;
  }
  if (draft.node === "defense") {
    const item = draft.value;
    return Boolean(item && typeof item.text === "string" && wordCount(item.text) <= 150
      && (!item.fact || hasChoice(choices.defenseFacts.choices, item.fact))
      && (!item.dev || validDevelopment(item.dev, value)));
  }
  if (draft.node === "r15") {
    const options = [{ id: "KEEP" }, ...choices.initialRec.choices.map((item) => ({ id: `SW-${item.id}` }))];
    if (typeof draft.value === "string") return hasChoice(options, draft.value);
    return Boolean(draft.value && hasChoice(options, draft.value.recommendation)
      && (draft.value.switchReason == null || hasChoice(choices.switchReason.choices, draft.value.switchReason)));
  }
  const list = draft.node === "r13"
    ? Object.values(choices.r13.choicesByRecommendation).flat()
    : draft.node === "r21"
      ? Object.values(choices.r21.choicesByTrack).flat()
      : draft.node === "r15b"
        ? choices.switchReason.choices
        : draft.node === "cal"
          ? choices.calendar.choices
          : draft.node === "msg"
            ? choices.message.choices
            : draft.node === "ev"
              ? choices.evidence.choices
              : choices[draft.node]?.choices;
  return Boolean(list && hasChoice(list, draft.value));
}

function validDevelopment(id, value) {
  const answers = value.answers;
  const response = answers.r26;
  if (!response || !answers.P || !answers.cal || !answers.msg || !answers.ev) return false;
  const trackName = track(confirmedRec(answers));
  const challenge = followUp(trackName, protection(answers.P, answers.cal, answers.msg, answers.ev));
  let effective = { P: answers.P, cal: answers.cal, msg: answers.msg, ev: answers.ev };
  let action = null;
  if (response.resp === "ACT" && challenge.X !== "X0") {
    action = applyAct(challenge.X, answers.P, answers.cal, answers.msg, response.drop);
    effective = { P: action.P, cal: action.cal, msg: action.msg, ev: answers.ev };
  }
  const outcome = complication(
    trackName,
    protection(effective.P, effective.cal, effective.msg, effective.ev),
    challenge,
    response.resp,
    action?.dropped,
  );
  return [
    `E2-${trackName}`,
    challenge.X,
    `RESPONSE-${response.resp}`,
    outcome?.C3,
  ].includes(id);
}

function initializeStorage() {
  try {
    savedRaw = window.localStorage.getItem(STORAGE_KEY);
    const probe = `${STORAGE_KEY}-probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
  } catch {
    storageAvailable = false;
  }
}

function loadSavedState() {
  if (!storageAvailable || !savedRaw) return;
  try {
    let restored = JSON.parse(savedRaw);
    if (!restored.checkpoints && stateIsValid(restored, true)) {
      restored = migrateLegacyState(restored, content.ui.checkpoints, SCREENS);
    }
    if (!stateIsValid(restored)) {
      invalidSavedState = true;
      return;
    }
    state = restored;
    if (state.locks.r3 && !state.completion.receipt) state.completion.receipt = buildReceipt(state);
    const round = ROUND_MAP[state.screen] ?? 1;
    const decision = SCREEN_DECISION[state.screen] ?? 1;
    const total = round === 1 ? 6 : round === 2 ? 7 : 4;
    restoreMessage = content.ui.storage.restored
      .replace("{round}", String(round))
      .replace("{decision}", String(decision))
      .replace("{total}", String(total));
    persist();
  } catch {
    invalidSavedState = true;
  }
}

function persist() {
  if (!state || !storageAvailable) return;
  state.updatedAt = now();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageAvailable = false;
  }
}

function newState() {
  const timestamp = now();
  return {
    schema: 1,
    appVersion: content.ui.appVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
    screen: "S1",
    draft: null,
    locks: { r1: false, r2: false, r3: false },
    answers: { defense: { fact: "", dev: "", text: "" } },
    checkpoints: newCheckpoints(content.ui.checkpoints),
    history: [],
    completion: { completedAt: null, receiptIssued: false, receipt: null },
  };
}

function saveDraft(node, value) {
  if (!state) return;
  state.draft = { node, value: clone(value), dirty: true };
  persist();
  updateBeforeUnload();
}

function clearDraft() {
  if (defenseSaveTimer !== null) {
    window.clearTimeout(defenseSaveTimer);
    defenseSaveTimer = null;
  }
  if (state) state.draft = null;
  updateBeforeUnload();
}

function saveDefenseDraft(value) {
  if (!state) return;
  state.answers.defense = clone(value);
  state.draft = { node: "defense", value: clone(value), dirty: true };
  updateBeforeUnload();
  if (defenseSaveTimer !== null) window.clearTimeout(defenseSaveTimer);
  defenseSaveTimer = window.setTimeout(() => {
    defenseSaveTimer = null;
    persist();
  }, 500);
}

function updateBeforeUnload() {
  window.onbeforeunload = state?.draft?.dirty
    ? (event) => {
        event.preventDefault();
        event.returnValue = "";
        return "";
      }
    : null;
}

function serializeValue(value) {
  return JSON.stringify(value);
}

function recordHistory(nodeId, value, supersededKeys = []) {
  if (!state) return;
  const seq = (state.history.at(-1)?.seq ?? 0) + 1;
  const supersededNodes = new Set([nodeId]);
  for (const key of supersededKeys) {
    if (NODE_KEYS[key]) supersededNodes.add(NODE_KEYS[key]);
  }
  for (const item of state.history) {
    if (item.status === "active" && supersededNodes.has(item.node)) {
      item.status = "superseded";
      item.supersededBy = seq;
      item.reason = `edit:${nodeId}`;
    }
  }
  state.history.push({ seq, node: nodeId, value: clone(value), at: now(), status: "active" });
}

function commitAnswer(key, value, nodeId, nextScreen) {
  commitAnswers([{ key, value, nodeId }], nextScreen);
}

function commitAnswers(entries, nextScreen) {
  const previousAnswers = clone(state.answers);
  for (const { key, value, nodeId } of entries) {
    if (serializeValue(state.answers[key]) !== serializeValue(value)) {
      state.answers[key] = clone(value);
      const result = invalidate(state.answers, key, previousAnswers);
      state.answers = result.answers;
      recordHistory(nodeId, value, result.superseded);
    }
  }
  clearDraft();
  if (nextScreen === "S6" && !checkpointPassed(state.checkpoints, content.ui.checkpoints.round1)) {
    state.checkpointReturn = { screen: "S5", draft: null, needsRound2: false };
    state.screen = "Q1";
  } else if (nextScreen === "S13" && !checkpointPassed(state.checkpoints, content.ui.checkpoints.round2)) {
    state.screen = "Q2";
  } else {
    state.screen = nextScreen;
  }
  persist();
  render();
}

function setScreen(screen) {
  clearDraft();
  state.screen = screen;
  persist();
  render();
}

function activeHistory(nodeId) {
  return [...(state?.history ?? [])].reverse().find((item) => item.node === nodeId && item.status === "active") ?? null;
}

function historyValue(item) {
  if (item.node === "R1.5" && item.value === "KEEP") return content.ui.copy.keepRecommendation;
  if (item.node === "R1.5" && item.value?.startsWith?.("SW-")) {
    return placeholder(content.ui.copy.dynamicSwitchTo, { v1: chosenOptionLabel(item.value.slice(3)) });
  }
  if (item.node === "R3.3") return content.ui.copy.defenseSubmitted;
  if (item.node === "R2.6" && item.value?.resp === "ACT") {
    const actionCopy = item.value.variant ? content.cards.actions[item.value.variant] : null;
    if (actionCopy && item.value.challenge) {
      const fixPriority = {
        "X-AWARE": "A",
        "X-BRAND": "D",
        "X-TIME": "B",
        "X-EXEC": "B",
        "X-FLOW": "C",
      }[item.value.challenge];
      return placeholder(actionCopy.result, {
        fixPriority: content.choices.labels[fixPriority] ?? "",
        droppedPriority: content.choices.labels[item.value.drop] ?? "",
      });
    }
    return item.value.drop
      ? placeholder(content.ui.copy.dynamicActRecordWithSwap, { dropped: content.choices.labels[item.value.drop] })
      : content.ui.copy.actNowRecord;
  }
  if (item.node === "R3.2" && item.value?.action) return authorizationLabel(item.value);
  if (item.node === "R2.2" && Array.isArray(item.value)) return priorityList(item.value);
  if (item.node === "R2.6" && item.value?.resp === "WATCH") return content.ui.copy.holdCourseAndWatchIt;
  if (item.node === "R2.6" && item.value?.resp === "X0") return content.ui.copy.structuredPreMortemSentence;
  if (item.node === "LOCK-R1") return chosenOptionLabel(item.value?.confirmedRec);
  if (item.node === "LOCK-R2") {
    return placeholder(content.ui.copy.round2PlanConfirmed, {
      P: priorityList(item.value?.P),
      cal: sentenceLabel(answerLabel(item.value?.cal)),
      msg: sentenceLabel(answerLabel(item.value?.msg)),
      ev: sentenceLabel(answerLabel(item.value?.ev)),
    });
  }
  return typeof item.value === "string" ? answerLabel(item.value) : content.ui.copy.choiceRecorded;
}

function answerLabel(id) {
  if (!id) return content.ui.copy.notSelected;
  const allChoices = [
    ...content.choices.nodes.lens.choices,
    ...content.choices.nodes.initialRec.choices,
    ...content.choices.nodes.r14.choices,
    ...content.choices.nodes.switchReason.choices,
    ...content.choices.nodes.priorities.choices,
    ...content.choices.nodes.calendar.choices,
    ...content.choices.nodes.message.choices,
    ...content.choices.nodes.evidence.choices,
    ...content.choices.nodes.response.choices,
    ...content.choices.nodes.r32.choices,
    ...content.choices.nodes.defenseFacts.choices,
    ...Object.values(content.choices.nodes.r13.choicesByRecommendation).flat(),
    ...Object.values(content.choices.nodes.r21.choicesByTrack).flat(),
    ...Object.values(content.cards.r31Responses).flat(),
    ...Object.values(content.cards.followUps.X0.choices),
  ];
  return allChoices.find((choice) => choice.id === id)?.label ?? content.ui.copy.notSelected;
}

function activeRound() {
  return ROUND_MAP[state?.screen] ?? 0;
}

function titleForScreen(screen) {
  const titles = {
    S0: content.ui.intro.title,
    S1: content.ui.ledger.title,
    Q1: content.ui.checkpoints.title1,
    S2: content.ui.copy.yourInitialRecommendation,
    S3: content.ui.copy.yourMainRationale,
    S4: content.ui.copy.theAssumptionYouRelyOn,
    S5: content.ui.copy.stressTestAndRecommendation,
    S5b: content.ui.copy.whyYouAreSwitching,
    S6: content.ui.copy.lockRound1,
    S7: content.ui.copy.readTheRound2Evidence,
    S8: content.ui.copy.setYourFirst90DayPriorities,
    S9: content.ui.copy.chooseThePromotionCalendar,
    S10: content.ui.copy.chooseThePromotionMessage,
    S11: content.ui.copy.chooseTheEvidenceToMonitor,
    S12: content.ui.copy.respondToTheFollowUp,
    Q2: content.ui.checkpoints.title2,
    S13: content.ui.copy.lockRound2,
    S14: content.ui.copy.aNewDevelopment,
    S15: content.ui.copy.authorizeOneAction,
    S16: content.ui.copy.defendYourFinalDecision,
    S17: content.ui.copy.debriefAndCompletionReceipt,
  };
  return titles[screen] ?? content.ui.intro.title;
}

function progressDetail(screen) {
  const round = ROUND_MAP[screen];
  if (!round) return content.ui.copy.introduction;
  if (screen === "Q1" || screen === "Q2") return content.ui.copy.evidenceCheckpoint;
  const indexes = {
    1: { S1: 1, S2: 2, S3: 3, S4: 4, S5: 5, S5b: 5, S6: 6 },
    2: { S7: 1, S8: 2, S9: 3, S10: 4, S11: 5, S12: 6, S13: 7 },
    3: { S14: 1, S15: 2, S16: 3, S17: 4 },
  };
  const total = round === 1 ? 6 : round === 2 ? 7 : 4;
  return placeholder(content.ui.copy.dynamicStepOf, { v1: indexes[round][screen], v2: total });
}

function roundProgress(parent, screen) {
  const current = ROUND_MAP[screen];
  const list = make("div", "progress");
  list.setAttribute("aria-label", content.ui.navigation.progress);
  content.ui.roundLabels.forEach((label, index) => {
    const item = make("div", "progress-item", label);
    if (current === index + 1) item.setAttribute("aria-current", "step");
    list.append(item);
  });
  parent.append(list, make("p", "progress-detail", progressDetail(screen)));
}

function paragraphList(parent, values) {
  for (const value of values ?? []) parent.append(make("p", "", value));
}

function section(parent, title, className = "") {
  const wrapper = make("section", className);
  if (title) wrapper.append(make("h2", "", title));
  parent.append(wrapper);
  return wrapper;
}

function panel(parent, title, text) {
  const item = make("section");
  item.append(make("h3", "", title), make("p", "", text));
  parent.append(item);
}

function standardPanel(parent, result) {
  if (!result) return;
  const region = make("div", "result-panel");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  region.append(make("h2", "", result.title ?? content.ui.copy.result));
  if (result.text) region.append(make("p", "", result.text));
  if (result.panel) {
    const grid = make("div", "panel-grid");
    if (result.panel.assumes) panel(grid, content.ui.copy.whatThisChoiceAssumes, result.panel.assumes);
    if (result.panel.risks) panel(grid, content.ui.copy.whatItPutsAtRisk, result.panel.risks);
    if (result.panel.watch) panel(grid, content.ui.copy.whatToWatch, result.panel.watch);
    if (grid.childElementCount) region.append(grid);
  }
  if (result.lines) paragraphList(region, result.lines);
  parent.append(region);
}

function scenarioBanner(parent) {
  const banner = make("p", "scenario-banner");
  banner.append(make("span", "data-label", content.ui.labels["SIMULATION SCENARIO"]), document.createTextNode(content.cards.scenarioBanner.replace(/^Simulation scenario:\s*/i, "")));
  parent.append(banner);
}

function makeButton(label, handler, className = "") {
  const button = make("button", className, label);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function makeChoiceGroup(parent, {
  legend,
  choices,
  name,
  value,
  multiple = false,
  min,
  max,
  showChoiceDetails = true,
  onChange,
}) {
  const fieldset = make("fieldset");
  fieldset.append(make("legend", "", legend));
  const list = make("div", "choice-list");
  const current = multiple ? (Array.isArray(value) ? value : []) : [value];
  const inputs = [];
  for (const choice of choices) {
    const label = make("label", "choice-card");
    const input = document.createElement("input");
    input.type = multiple ? "checkbox" : "radio";
    input.name = name;
    input.value = choice.id;
    input.checked = current.includes(choice.id);
    const details = make("span");
    details.append(make("span", "choice-label", choice.label));
    if (showChoiceDetails && choice.protects) details.append(make("span", "choice-detail", placeholder(content.ui.copy.dynamicProtects, { v1: choice.protects })));
    if (showChoiceDetails && choice.costs) details.append(make("span", "choice-detail", placeholder(content.ui.copy.dynamicCosts, { v1: choice.costs })));
    if (showChoiceDetails && choice.changes) details.append(make("span", "choice-detail", choice.changes));
    if (showChoiceDetails && choice.panel && typeof choice.panel === "object") {
      const panelText = [
        choice.panel.assumes && placeholder(content.ui.copy.dynamicAssumes, { v1: choice.panel.assumes }),
        choice.panel.risks && placeholder(content.ui.copy.dynamicRisks, { v1: choice.panel.risks }),
        choice.panel.watch && placeholder(content.ui.copy.dynamicWatch, { v1: choice.panel.watch }),
      ].filter(Boolean).join(" ");
      if (panelText) details.append(make("span", "choice-detail", panelText));
    } else if (showChoiceDetails && choice.panel) {
      details.append(make("span", "choice-detail", choice.panel));
    }
    input.addEventListener("change", () => {
      let selected;
      if (multiple) {
        selected = inputs.filter((item) => item.checked).map((item) => item.value);
      } else {
        selected = input.value;
      }
      onChange(selected);
    });
    label.append(input, details);
    list.append(label);
    inputs.push(input);
  }
  fieldset.append(list);
  parent.append(fieldset);
  const isValid = () => {
    const selected = inputs.filter((input) => input.checked).length;
    return multiple ? selected >= (min ?? 0) && selected <= (max ?? Infinity) : selected > 0;
  };
  const selectedValues = () => multiple
    ? inputs.filter((input) => input.checked).map((input) => input.value)
    : inputs.find((input) => input.checked)?.value ?? "";
  return { fieldset, inputs, isValid, selectedValues };
}

function nodeValue(key) {
  const draft = state?.draft;
  if (draft?.node === key) return draft.value;
  return state?.answers?.[key];
}

function addContinue(parent, label, enabled, handler) {
  const button = makeButton(label ?? content.ui.navigation.continue, handler);
  button.disabled = !enabled;
  parent.append(button);
  return button;
}

function navButtons(parent, { back, next, nextLabel, enabled = true } = {}) {
  const row = make("div", "navigation-row");
  if (back) row.append(makeButton(content.ui.navigation.back, back, "secondary"));
  const right = make("div", "right-actions");
  if (next) addContinue(right, nextLabel, enabled, next);
  row.append(right);
  parent.append(row);
}

function updateChoiceButton(button, group) {
  if (button) button.disabled = !group.isValid();
}

function announceHeading(heading) {
  heading.tabIndex = -1;
  requestAnimationFrame(() => heading.focus());
}

function updatePageHeader(screen, heading) {
  roundProgress(screenRegion, screen);
  announceHeading(heading);
}

function placeholder(text, values) {
  return text.replace(/\{([^}]+)\}/g, (match, key) => values[key] ?? match);
}

function formatCurrency(value) {
  return `$${Math.floor(value + 0.5).toLocaleString("en-US")}`;
}

function roundName(value) {
  if (state?.screen === "Q1") return content.ui.checkpoints.title1;
  if (state?.screen === "Q2") return content.ui.checkpoints.title2;
  return content.ui.roundLabels[value - 1] ?? "";
}

function priorityList(values) {
  return (values ?? []).map((item) => content.choices.labels[item] ?? item).join(", ");
}

function makeTable(parent, captionText, headers, rows, { firstColumnHeader = false } = {}) {
  const wrap = make("div", "table-wrap");
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = captionText;
  table.append(caption);
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach((text) => headerRow.append(make("th", "", text)));
  thead.append(headerRow);
  table.append(thead);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    row.forEach((cell, index) => {
      const element = document.createElement(firstColumnHeader && index === 0 ? "th" : "td");
      if (element.tagName === "TH") element.scope = "row";
      element.textContent = String(cell);
      tr.append(element);
    });
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  parent.append(wrap);
  return table;
}

function displayLedger(parent) {
  paragraphList(parent, content.ui.ledger.leadIn);
  const rows = content.ui.ledger.summaryRows.map((row) => [row.label, ...row.values]);
  makeTable(
    parent,
    content.ui.copy.summaryProjectionCaption,
    [content.ui.copy.measure, ...content.ui.ledger.columns],
    rows,
    { firstColumnHeader: true },
  );
  displayProjectionDetails(parent);
}

function displayProjectionDetails(parent) {
  const details = document.createElement("details");
  details.className = "details-panel";
  details.append(make("summary", "", content.ui.copy.viewProjections));
  const inside = make("div", "details-content");
  makeTable(
    inside,
    content.ui.copy.originalProjectionFullYearAssumptionsUnchangedNotReForecast,
    [content.ui.copy.measure, ...content.ui.ledger.columns],
    content.ui.ledger.rows.map((row) => [row.label, ...row.values]),
    { firstColumnHeader: true },
  );
  const calculations = section(inside, content.ui.copy.calculations);
  paragraphList(calculations, content.ui.ledger.calculations);
  const assumptions = section(inside, content.ui.copy.modelingAssumptions);
  paragraphList(assumptions, content.ui.ledger.assumptions);
  inside.append(make("p", "info-panel", content.ui.ledger.note));
  details.append(inside);
  parent.append(details);
}

function createField(labelText, parent, element) {
  const label = make("label", "field-label", labelText);
  if (element.id) label.htmlFor = element.id;
  parent.append(label, element);
  return element;
}

function currentTrack() {
  return track(confirmedRec(state.answers));
}

function currentRound2() {
  const answers = state.answers;
  const trackName = currentTrack();
  const base = { P: answers.P ?? [], cal: answers.cal, msg: answers.msg, ev: answers.ev };
  const protectedBefore = protection(base.P, base.cal, base.msg, base.ev);
  const challenge = followUp(trackName, protectedBefore);
  let action = null;
  let effective = { ...base };
  if (answers.r26?.resp === "ACT" && challenge.X !== "X0") {
    action = applyAct(challenge.X, base.P, base.cal, base.msg, answers.r26.drop);
    effective = { P: action.P, cal: action.cal, msg: action.msg, ev: base.ev };
  }
  const protectedAfter = protection(effective.P, effective.cal, effective.msg, effective.ev);
  const complicationResult = answers.r26
    ? complication(trackName, protectedAfter, challenge, answers.r26.resp, action?.dropped)
    : null;
  return { trackName, base, challenge, action, effective, protectedBefore, protectedAfter, complicationResult };
}

function finalRound3State() {
  const round2 = currentRound2();
  const answers = state.answers;
  const final = {
    rec: confirmedRec(answers),
    P: [...round2.effective.P],
    cal: round2.effective.cal,
    msg: round2.effective.msg,
    ev: round2.effective.ev,
  };
  const authorized = answers.r32;
  if (!authorized) return final;
  if (authorized.action === "REFINE-CAL" && authorized.sub) final.cal = authorized.sub;
  if (authorized.action === "REFINE-MSG" && authorized.sub) final.msg = authorized.sub;
  if (authorized.action === "REFINE-PRI" && authorized.sub) final.P = [...authorized.sub];
  if (authorized.action?.startsWith("REVISE-")) final.rec = authorized.action.slice("REVISE-".length);
  return final;
}

function round3Outcome() {
  const round2 = currentRound2();
  return round2.complicationResult;
}

function panelResult(title, panelValue) {
  return { title, panel: panelValue };
}

function choiceById(choices, id) {
  return choices.find((item) => item.id === id);
}

function rationaleChoice() {
  const recommendation = state.answers.initialRec;
  return choiceById(content.choices.nodes.r13.choicesByRecommendation[recommendation] ?? [], state.answers.r13);
}

function diagnosisChoice() {
  return choiceById(content.choices.nodes.r21.choicesByTrack[currentTrack()] ?? [], state.answers.r21);
}

function chosenOptionLabel(id) {
  return choiceById(content.choices.nodes.initialRec.choices, id)?.label ?? id ?? content.ui.copy.notSelected;
}

function round2ResponseResult() {
  const round2 = currentRound2();
  const response = state.answers.r26;
  if (!response) return null;
  if (response.resp === "WATCH") {
    const linkLabel = content.choices.labels[round2.challenge.link] ?? content.ui.copy.thePreMortem;
    return { title: content.ui.copy.round2Response, text: placeholder(content.cards.actions.watchResult, { "X label": linkLabel }) };
  }
  if (response.resp === "X0") {
    return { title: content.ui.copy.structuredPreMortem, text: content.cards.followUps.X0.result };
  }
  const action = round2.action;
  const copy = content.cards.actions[action.variant];
  return {
    title: content.ui.copy.round2Response,
    text: placeholder(copy.result, {
      fixPriority: content.choices.labels[action.added] ?? "",
      droppedPriority: content.choices.labels[action.dropped] ?? "",
    }),
  };
}

function r32Sentence() {
  const response = state.answers.r31;
  const outcome = round3Outcome();
  const responseRow = Object.values(content.cards.r31Responses).flat().find((item) => item.id === response);
  const action = state.answers.r32;
  if (!responseRow || !action) return "";
  const actionText = authorizationLabel(action);
  if (!responseRow.impliesChange) {
    return placeholder(content.ui.round3.noChangeSentence, { label: sentenceLabel(responseRow.label), action: actionText });
  }
  if (action.action === "RETAIN") {
    return placeholder(content.ui.round3.retainSentence, { label: sentenceLabel(responseRow.label) });
  }
  if (action.action.startsWith("REFINE-")) {
    const lever = { "REFINE-CAL": content.ui.copy.calendar, "REFINE-MSG": content.ui.copy.message, "REFINE-PRI": content.ui.copy.priorities }[action.action];
    return placeholder(content.ui.round3.refineSentence, { label: sentenceLabel(responseRow.label), lever });
  }
  if (action.action.startsWith("REVISE-")) {
    return placeholder(content.ui.round3.reviseSentence, { label: sentenceLabel(responseRow.label), option: chosenOptionLabel(action.action.slice(7)) });
  }
  return outcome ? "" : "";
}

function authorizationLabel(action) {
  if (!action) return content.ui.copy.notSelected;
  if (action.action === "RETAIN") return content.ui.copy.retainNoChange;
  if (action.action === "REFINE-CAL") return placeholder(content.ui.copy.authorizedCalendar, { value: answerLabel(action.sub) });
  if (action.action === "REFINE-MSG") return placeholder(content.ui.copy.authorizedMessage, { value: answerLabel(action.sub) });
  if (action.action === "REFINE-PRI") return placeholder(content.ui.copy.authorizedPriorities, { value: priorityList(action.sub) });
  return placeholder(content.ui.copy.dynamicRedirectTheRemainingBudgetTo, { v1: chosenOptionLabel(action.action.slice(7)) });
}

function sentenceLabel(value) {
  return value.replace(/[.!?]+$/, "");
}

function resultFor(screen) {
  const answers = state.answers;
  if (screen === "S2" && answers.lens) {
    return { title: content.ui.copy.lensRecorded, text: placeholder(content.ui.copy.dynamicLensRecordedDollarsAndMarginStayVisible, { v1: sentenceLabel(answerLabel(answers.lens)) }) };
  }
  if (screen === "S3" && answers.initialRec) {
    return { title: content.ui.copy.initialRecommendation, text: placeholder(content.ui.copy.dynamicInitialRecommendationRecorded, { v1: chosenOptionLabel(answers.initialRec) }) };
  }
  if (screen === "S8" && answers.r21) {
    const choice = diagnosisChoice();
    return choice ? panelResult(content.ui.copy.diagnosis, choice.panel) : null;
  }
  if (screen === "S9" && answers.P) {
    return { title: content.ui.copy.prioritiesRecorded, text: placeholder(content.ui.copy.dynamicYourPrioritiesNotFundedThisPeriod, { v1: priorityList(answers.P), v2: priorityList(PRIORITIES.filter((item) => !answers.P.includes(item))) }) };
  }
  if (screen === "S10" && answers.cal) {
    const choice = choiceById(content.choices.nodes.calendar.choices, answers.cal);
    return choice ? panelResult(content.ui.copy.calendarChoice, choice.panel) : null;
  }
  if (screen === "S11" && answers.msg) return { title: content.ui.copy.messageChoice, text: messageConsequence() };
  if (screen === "S12" && answers.ev) {
    const choice = choiceById(content.choices.nodes.evidence.choices, answers.ev);
    return choice ? panelResult(content.ui.copy.evidenceChoice, choice.panel) : null;
  }
  return null;
}

function messageConsequence() {
  const discountPriority = state.answers.P.includes("D");
  const template = content.ui.copy.messageEffects[state.answers.msg][discountPriority ? "discipline" : "noDiscipline"];
  return placeholder(template, {
    calendar: sentenceLabel(answerLabel(state.answers.cal)),
    priorities: priorityList(state.answers.P),
  });
}

function showStorageNotice(parent) {
  if (!storageAvailable) {
    const notice = make("div", "notice");
    notice.append(make("p", "", content.ui.storage.unavailable));
    const link = make("a", "button-link", content.ui.copy.openInANewTab);
    link.href = "index.html";
    link.target = "_blank";
    link.rel = "noopener";
    notice.append(link);
    parent.append(notice);
  } else if (restoreMessage) {
    parent.append(make("div", "notice", restoreMessage));
    restoreMessage = "";
  }
  if (otherTabOpen) parent.append(make("div", "notice", content.ui.storage.otherTab));
}

function displayHistory(parent) {
  if (!state || !["S2", "S3", "S4", "S5", "S5b", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "S16"].includes(state.screen)) return;
  const details = document.createElement("details");
  details.className = "details-panel";
  details.append(make("summary", "", content.ui.navigation.decisions));
  const body = make("div", "details-content");
  const current = activeRound();
  const status = (round, locked) => locked
    ? content.ui.copy.locked
    : current < round
      ? content.ui.copy.notStarted
      : content.ui.copy.inProgress;
  body.append(make("p", "", placeholder(content.ui.copy.dynamicRound1, { v1: status(1, state.locks.r1) })));
  body.append(make("p", "", placeholder(content.ui.copy.dynamicRound2, { v1: status(2, state.locks.r2) })));
  body.append(make("p", "", placeholder(content.ui.copy.dynamicRound3, { v1: status(3, state.locks.r3) })));
  body.append(make("p", "", placeholder(content.ui.copy.dynamicLens, { v1: sentenceLabel(answerLabel(state.answers.lens)) })));
  body.append(make("p", "", placeholder(content.ui.copy.dynamicInitialRecommendation, { v1: chosenOptionLabel(state.answers.initialRec) })));
  body.append(make("p", "", placeholder(content.ui.copy.dynamicConfirmedRecommendation, { v1: chosenOptionLabel(confirmedRec(state.answers)) })));
  const list = make("ol");
  for (const item of state.history) {
    const line = make("li", item.status === "superseded" ? "changed" : "");
    const value = historyValue(item);
    const nodeLabel = content.ui.historyLabels[item.node] ?? content.ui.copy.choiceRecorded;
    const statusLabel = item.status === "superseded" ? content.ui.copy.earlierAnswer : content.ui.copy.currentAnswer;
    line.textContent = `${nodeLabel}: ${value} (${statusLabel})`;
    list.append(line);
  }
  body.append(list);
  details.append(body);
  parent.append(details);
}

function renderFrame(screen) {
  const card = make("article", "screen-card");
  if (screen !== "S0") {
    const header = make("header", "screen-header");
    const heading = make("h1", "", titleForScreen(screen));
    header.append(make("p", "eyebrow", roundName(ROUND_MAP[screen])), heading);
    card.append(header);
    if ((ROUND_MAP[screen] ?? 0) >= 2 && screen !== "S17") scenarioBanner(card);
    roundProgress(screenRegion, screen);
    showStorageNotice(screenRegion);
    if (state) {
      displayHistory(screenRegion);
    }
    const instructions = document.createElement("details");
    instructions.className = "details-panel";
    instructions.append(make("summary", "", content.ui.intro.workflowTitle));
    appendWorkflow(instructions);
    screenRegion.append(instructions);
    const result = resultFor(screen);
    if (result) standardPanel(card, result);
  } else {
    showStorageNotice(screenRegion);
    const header = make("header", "screen-header");
    header.append(make("p", "eyebrow", content.ui.copy.promotingLandNatureJerky), make("h1", "", titleForScreen(screen)));
    card.append(header);
  }
  screenRegion.append(card);
  return card;
}

function appendWorkflow(parent) {
  const list = make("ol", "details-content");
  for (const step of content.ui.intro.workflow) list.append(make("li", "", step));
  parent.append(list);
}

function appendLabeledParagraph(parent, text) {
  const match = /^(CASE FACT|CALCULATION|ASSUMPTION|SIMULATION SCENARIO|YOUR JUDGMENT)\.\s*(.*)$/s.exec(text);
  const paragraph = make("p");
  if (match) {
    paragraph.append(make("span", "data-label", content.ui.labels[match[1]]), document.createTextNode(match[2]));
  } else {
    paragraph.textContent = text;
  }
  parent.append(paragraph);
}

function renderS0(card) {
  const openLink = make("a", "button-link", content.ui.copy.openInANewTab);
  openLink.href = "index.html";
  openLink.target = "_blank";
  openLink.rel = "noopener";
  card.append(openLink);
  paragraphList(card, content.ui.intro.body);
  card.append(make("h2", "", content.ui.intro.workflowTitle));
  appendWorkflow(card);
  if (storageAvailable) card.append(make("p", "privacy-note", content.ui.storage.saved));
  card.append(makeButton(state ? content.ui.intro.resume : content.ui.intro.begin, () => {
    if (!state) {
      state = newState();
      persist();
    }
    showingWelcome = false;
    updateBeforeUnload();
    render();
  }));
  if (state) renderStartOver(card);
}

function renderCheckpoint(card, round) {
  const definition = content.ui.checkpoints;
  const ids = round === 1 ? definition.round1 : definition.round2;
  card.append(make("p", "", definition.instructions));
  if (state.checkpointReturn?.migrated) {
    card.append(make("p", "notice", round === 1 ? definition.legacyRound1 : definition.legacyRound2));
  }
  for (const id of ids) {
    const concept = definition.concepts[id];
    const saved = state.checkpoints[id];
    const area = section(card, concept.title);
    if (saved.passed) {
      area.append(make("p", "info-panel", definition.passed));
      const lastAttempt = saved.history.at(-1);
      const completedVariant = concept.variants[lastAttempt?.variant];
      if (completedVariant?.explanation) {
        area.append(make("p", "", completedVariant.explanation));
      }
      continue;
    }
    if (saved.history.length) {
      const notice = make("div", "notice");
      notice.setAttribute("role", "status");
      notice.append(make("p", "", definition.retry), make("p", "", concept.hint));
      area.append(notice);
    }
    const question = concept.variants[saved.variant];
    const group = makeChoiceGroup(area, {
      legend: question.prompt,
      choices: question.options,
      name: `checkpoint-${id}`,
      value: saved.selection,
      onChange: (selection) => {
        state.checkpoints[id].selection = selection;
        persist();
      },
    });
    const check = addContinue(area, definition.check, group.isValid(), () => {
      state.checkpoints[id] = submitEvidence(state.checkpoints[id], concept, group.selectedValues());
      persist();
      render();
    });
    group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(check, group)));
  }
  const complete = checkpointPassed(state.checkpoints, ids);
  if (complete) card.append(make("p", "info-panel", definition.passedBoth));
  const nextLabel = round === 2 && complete ? definition.reviewRound2 : definition.continue;
  addContinue(card, nextLabel, complete, () => {
    if (!checkpointPassed(state.checkpoints, ids)) return;
    state = checkpointTransition(state, round, definition);
    updateBeforeUnload();
    persist();
    render();
  });
}

function renderS1(card) {
  displayLedger(card);
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.lens.prompt,
    choices: content.choices.nodes.lens.choices,
    name: "lens",
    value: nodeValue("lens"),
    onChange: (value) => saveDraft("lens", value),
  });
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("lens", group.selectedValues(), NODE_KEYS.lens, "S2");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function renderS2(card) {
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.initialRec.prompt,
    choices: content.choices.nodes.initialRec.choices,
    name: "initialRec",
    value: nodeValue("initialRec"),
    onChange: (value) => saveDraft("initialRec", value),
  });
  displayProjectionDetails(card);
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("initialRec", group.selectedValues(), NODE_KEYS.initialRec, "S3");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function renderS3(card) {
  const recommendation = state.answers.initialRec;
  const options = content.choices.nodes.r13.choicesByRecommendation[recommendation] ?? [];
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.r13.prompt,
    choices: options,
    name: "r13",
    value: nodeValue("r13"),
    showChoiceDetails: false,
    onChange: (value) => saveDraft("r13", value),
  });
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("r13", group.selectedValues(), NODE_KEYS.r13, "S4");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function renderS4(card) {
  const rationale = rationaleChoice();
  if (rationale) {
    card.append(make("p", "info-panel", placeholder(content.ui.copy.rationaleReminder, {
      recommendation: chosenOptionLabel(state.answers.initialRec),
      reason: rationale.label,
    })));
  }
  const choices = content.choices.nodes.r14.choices.map((choice) => choice.id === "A-AVG"
    ? {
      ...choice,
      label: state.answers.initialRec === "O1"
        ? content.ui.copy.removedPromotionAssumption
        : content.ui.copy.addedPromotionAssumption,
    }
    : choice);
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.r14.prompt,
    choices,
    name: "r14",
    value: nodeValue("r14"),
    showChoiceDetails: false,
    onChange: (value) => saveDraft("r14", value),
  });
  let button;
  button = addContinue(card, content.ui.copy.continueToStressTest, group.isValid(), () => {
    commitAnswer("r14", group.selectedValues(), NODE_KEYS.r14, "S5");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function renderS5(card) {
  const assumption = state.answers.r14;
  const cardId = `ST-${state.answers.initialRec}-${assumption.slice(2)}`;
  const stress = content.cards.stressTests[cardId];
  if (!stress) throw new TypeError(`CONTENT MISSING: ${cardId}`);
  card.append(make("p", "info-panel", placeholder(content.ui.copy.stressTestContext, {
    recommendation: chosenOptionLabel(state.answers.initialRec),
    assumption: answerLabel(assumption),
  })));
  const body = section(card, stress.title);
  stress.paragraphs.forEach((paragraph) => appendLabeledParagraph(body, paragraph));
  body.append(make("p", "info-panel", stress.whatChanges));
  if (state.answers.initialRec === "O2") {
    const recovery = section(body, content.cards.option2Recovery.title, "info-panel");
    for (const line of content.cards.option2Recovery.lines) {
      const item = make("p");
      item.append(make("strong", "", `${line.label}: `), document.createTextNode(line.text));
      recovery.append(item);
    }
  }
  if (!state.answers.r14CardViewed) {
    state.answers.r14CardViewed = true;
    persist();
  }
  const round1Passed = checkpointPassed(state.checkpoints, content.ui.checkpoints.round1);
  if (!round1Passed) {
    card.append(makeButton(content.ui.copy.continueToEvidenceCheck, () => {
      state.checkpointReturn = { screen: "S5", draft: null, needsRound2: false, migrated: false };
      state.screen = "Q1";
      persist();
      render();
    }));
    navButtons(card, { back: () => setScreen("S4") });
    return;
  }
  card.append(make("p", "info-panel", content.ui.copy.passedBothChecks));
  const choices = [
    { id: "KEEP", label: placeholder(content.ui.copy.dynamicKeepMyRecommendation, { v1: chosenOptionLabel(state.answers.initialRec) }) },
    ...content.choices.nodes.initialRec.choices
      .filter((choice) => choice.id !== state.answers.initialRec)
      .map((choice) => ({ id: `SW-${choice.id}`, label: placeholder(content.ui.copy.dynamicSwitchTo, { v1: choice.label }) })),
  ];
  const recommendationDraft = nodeValue("r15");
  const group = makeChoiceGroup(card, {
    legend: content.ui.copy.afterTheStressTestWhatDoYouRecommend,
    choices,
    name: "r15",
    value: typeof recommendationDraft === "object" ? recommendationDraft.recommendation : recommendationDraft,
    onChange: (value) => saveDraft("r15", {
      recommendation: value,
      switchReason: state.draft?.node === "r15" ? state.draft.value.switchReason : null,
    }),
  });
  const reasonArea = section(card, content.ui.copy.switchReasonSection);
  const reasonGroup = makeChoiceGroup(reasonArea, {
    legend: content.choices.nodes.switchReason.prompt,
    choices: content.choices.nodes.switchReason.choices,
    name: "r15b",
    value: state.draft?.node === "r15" ? state.draft.value.switchReason : state.answers.r15b,
    onChange: (value) => saveDraft("r15", {
      recommendation: group.selectedValues(),
      switchReason: value,
    }),
  });
  const evidence = document.createElement("textarea");
  evidence.id = "r1-evidence";
  evidence.rows = 2;
  evidence.value = state.answers.r15Evidence ?? "";
  createField(content.ui.copy.evidenceNeeded, card, evidence);
  evidence.addEventListener("input", () => {
    state.answers.r15Evidence = evidence.value;
    persist();
  });
  const updateReasonVisibility = () => {
    reasonArea.hidden = !group.selectedValues()?.startsWith("SW-");
  };
  group.inputs.forEach((input) => input.addEventListener("change", updateReasonVisibility));
  updateReasonVisibility();
  let button;
  const ready = () => group.isValid()
    && (!group.selectedValues().startsWith("SW-") || reasonGroup.isValid())
    && evidence.value.trim().length > 0;
  button = addContinue(card, content.ui.navigation.continue, ready(), () => {
    const value = group.selectedValues();
    if (!ready()) return;
    const entries = [{ key: "r15", value, nodeId: NODE_KEYS.r15 }];
    if (value.startsWith("SW-")) {
      entries.push({ key: "r15b", value: reasonGroup.selectedValues(), nodeId: NODE_KEYS.r15b });
    }
    commitAnswers(entries, "S6");
  });
  const updateButton = () => { button.disabled = !ready(); };
  group.inputs.forEach((input) => input.addEventListener("change", updateButton));
  reasonGroup.inputs.forEach((input) => input.addEventListener("change", updateButton));
  evidence.addEventListener("input", updateButton);
  navButtons(card, { back: () => setScreen("S4") });
}

function renderS5b(card) {
  const group = makeChoiceGroup(card, {
    legend: content.ui.copy.whatChangedYourMind,
    choices: content.choices.nodes.switchReason.choices,
    name: "r15b",
    value: nodeValue("r15b"),
    onChange: (value) => saveDraft("r15b", value),
  });
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("r15b", group.selectedValues(), NODE_KEYS.r15b, "S6");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
  navButtons(card, { back: () => setScreen("S5") });
}

function renderS6(card) {
  const summary = make("div", "info-panel");
  summary.append(make("h2", "", content.ui.copy.recommendationReview));
  summary.append(make("p", "", placeholder(content.ui.copy.summaryRecommendation, { v1: chosenOptionLabel(state.answers.initialRec) })));
  if (confirmedRec(state.answers) !== state.answers.initialRec) {
    summary.append(make("p", "", placeholder(content.ui.copy.summaryRevisedRecommendation, { v1: chosenOptionLabel(confirmedRec(state.answers)) })));
  }
  summary.append(make("p", "", placeholder(content.ui.copy.summaryLens, { v1: sentenceLabel(answerLabel(state.answers.lens)) })));
  const rationale = rationaleChoice();
  if (rationale) summary.append(make("p", "", placeholder(content.ui.copy.summaryReason, { v1: rationale.label })));
  summary.append(make("p", "", placeholder(content.ui.copy.summaryAssumption, { v1: sentenceLabel(answerLabel(state.answers.r14)) })));
  if (state.answers.r15Evidence) {
    summary.append(make("p", "", placeholder(content.ui.copy.dynamicEvidenceWanted, { v1: state.answers.r15Evidence })));
  }
  card.append(summary);
  if (state.locks.r1) {
    card.append(makeButton(content.ui.copy.continueToRound2, () => setScreen("S7")));
  } else {
    card.append(makeButton(content.ui.copy.reviewRound1, () => {
      state.locks.r1 = true;
      recordHistory("LOCK-R1", { confirmedRec: confirmedRec(state.answers) });
      state.screen = "S7";
      persist();
      render();
    }));
    card.append(makeButton(content.ui.navigation.goBack, () => setScreen("S5"), "secondary"));
  }
}

function renderS7(card) {
  const trackName = currentTrack();
  const event = section(card, content.cards.eventHeadlines[trackName]);
  event.append(make("p", "", content.cards.events[trackName]));
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.r21.prompt,
    choices: content.choices.nodes.r21.choicesByTrack[trackName],
    name: "r21",
    value: nodeValue("r21"),
    showChoiceDetails: false,
    onChange: (value) => saveDraft("r21", value),
  });
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("r21", group.selectedValues(), NODE_KEYS.r21, "S8");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function renderS8(card) {
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.priorities.prompt,
    choices: content.choices.nodes.priorities.choices,
    name: "P",
    value: nodeValue("P"),
    multiple: true,
    min: 2,
    max: 2,
    onChange: (value) => saveDraft("P", value),
  });
  const hint = make("p", "progress-detail", content.ui.copy.selectExactlyTwoPriorities);
  const count = make("p", "progress-detail", placeholder(content.ui.copy.selectedPriorityCount, { v1: group.selectedValues().length }));
  count.setAttribute("aria-live", "polite");
  card.append(hint, count);
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("P", group.selectedValues(), NODE_KEYS.P, "S9");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => {
    updateChoiceButton(button, group);
    count.textContent = placeholder(content.ui.copy.selectedPriorityCount, { v1: group.selectedValues().length });
  }));
}

function calendarPattern(calendar) {
  return content.ui.copy.months.map((month, index) => {
    const evenMonth = index % 2 === 1;
    if (calendar === "KEEP") return { month, consumer: evenMonth, trade: !evenMonth, media: false };
    if (calendar === "ALIGN") return { month, consumer: evenMonth, trade: evenMonth, media: evenMonth };
    return { month, consumer: true, trade: true, media: false };
  });
}

function renderCalendarDetails(parent, calendar) {
  const pattern = calendarPattern(calendar);
  const activeConsumer = pattern.filter((month) => month.consumer).length;
  const activeTrade = pattern.filter((month) => month.trade).length;
  const both = pattern.filter((month) => month.consumer && month.trade).length;
  const gridRows = [
    [content.ui.copy.consumerPromotion, ...pattern.map((month) => month.consumer ? "C" : "—")],
    [content.ui.copy.tradePromotion, ...pattern.map((month) => month.trade ? "T" : "—")],
    [content.ui.copy.mediaBurst, ...pattern.map((month) => month.media ? "M↑" : "—")],
  ];
  makeTable(
    parent,
    placeholder(content.ui.copy.dynamic12MonthCalendar, { v1: calendar }),
    [content.ui.copy.pattern, ...content.ui.copy.months],
    gridRows,
    { firstColumnHeader: true },
  ).classList.add("month-grid");

  const textEquivalent = pattern.map((month) => {
    if (calendar === "KEEP") return `${month.month}: ${month.consumer ? content.ui.copy.consumerPromotion.toLowerCase() : content.ui.copy.tradePromotion.toLowerCase()}`;
    if (calendar === "ALIGN") return month.consumer
      ? placeholder(content.ui.copy.dynamicConsumerAndTradePromotionsWithAMediaBurst, { v1: month.month })
      : placeholder(content.ui.copy.dynamicPromotionFreeQuieterMedia, { v1: month.month });
    return placeholder(content.ui.copy.dynamicConsumerAndTradePromotions, { v1: month.month });
  });
  const equivalent = section(parent, content.ui.copy.textEquivalentForThe12MonthGrid);
  paragraphList(equivalent, [textEquivalent.join("; ") + "."]);
  paragraphList(equivalent, [placeholder(content.ui.copy.dynamicActiveMonthsConsumerTradeMonthsWithBothPromotions, { v1: activeConsumer, v2: activeTrade, v3: both })]);

  const spending = perMonthSpend(currentTrack(), calendar, content.ledger);
  makeTable(
    parent,
    content.ui.copy.perMonthPromotionSpendAnnualEquivalentIllustration,
    [content.ui.copy.track, content.ui.copy.consumerPerActiveMonth, content.ui.copy.tradePerActiveMonth, content.ui.copy.combinedPerLiveMonth],
    [[currentTrack(), formatCurrency(spending.consumer), formatCurrency(spending.trade), formatCurrency(spending.combined)]],
  );
  const aware = state.answers.P.includes("A");
  const phasing = mediaPhasing(calendar, state.answers.P, {
    anchorMonths: 6,
    quietMonths: 6,
    uncommittedMedia: content.ledger.inputs.media,
  });
  makeTable(
    parent,
    content.ui.copy.mediaAllocationAnnualEquivalentIllustration,
    [content.ui.copy.allocation, content.ui.copy.anchorMonthsEven, content.ui.copy.quietMonthsOdd, content.ui.copy.perAnchorMonth, content.ui.copy.perQuietMonth],
    [[
      calendar === "ALIGN" ? (aware ? content.ui.copy.sixtyForty : content.ui.copy.twoThirdsOneThird) : content.ui.copy.flat,
      formatCurrency(phasing.totals.anchor),
      formatCurrency(phasing.totals.quiet),
      formatCurrency(phasing.perMonth.anchor),
      formatCurrency(phasing.perMonth.quiet),
    ]],
  );
  parent.append(make("p", "info-panel", content.ui.copy.thisAnnualEquivalentIllustrationAssumesThePatternRanAllYearAfterYouChooseTh));
  const ratio = calendar === "ALIGN"
    ? (aware ? content.ui.copy.quietMediaTwoThirds : content.ui.copy.quietMediaHalf)
    : content.ui.copy.quietMediaEqual;
  parent.append(make("p", "", ratio));
  parent.append(make("p", "", content.ui.copy.alignIsATimingAndMediaChangeItDoesNotConcentrateSpendingPerPromotionTypeOve));
}

function renderS9(card) {
  const selectedCalendar = nodeValue("cal") ?? state.answers.cal;
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.calendar.prompt,
    choices: content.choices.nodes.calendar.choices,
    name: "cal",
    value: nodeValue("cal"),
    onChange: (value) => {
      saveDraft("cal", value);
      renderPreview(value);
    },
  });
  const preview = make("div");
  card.append(preview);
  const renderPreview = (calendar) => {
    preview.replaceChildren();
    if (!calendar) return;
    const detail = section(preview, content.ui.copy.calendarPatternAndAnnualEquivalentIllustrations);
    renderCalendarDetails(detail, calendar);
  };
  renderPreview(selectedCalendar);
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("cal", group.selectedValues(), NODE_KEYS.cal, "S10");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function renderS10(card) {
  card.append(make("p", "info-panel", content.ui.copy.priceContext));
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.message.prompt,
    choices: content.choices.nodes.message.choices,
    name: "msg",
    value: nodeValue("msg"),
    onChange: (value) => saveDraft("msg", value),
  });
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("msg", group.selectedValues(), NODE_KEYS.msg, "S11");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function renderS11(card) {
  card.append(make("p", "info-panel", content.ui.copy.priceContext));
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.evidence.prompt,
    choices: content.choices.nodes.evidence.choices,
    name: "ev",
    value: nodeValue("ev"),
    onChange: (value) => saveDraft("ev", value),
  });
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("ev", group.selectedValues(), NODE_KEYS.ev, "S12");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function followUpText(round2) {
  const { challenge, trackName, effective } = round2;
  if (challenge.X === "X0") return null;
  const source = content.cards.followUps[challenge.X];
  if (!source) throw new TypeError(`CONTENT MISSING: ${challenge.X}`);
  const values = {
    calendar: source.calendar?.[effective.cal] ?? "",
    message: source.message?.[effective.msg] ?? "",
    media: effective.cal === "ALIGN" && !effective.P.includes("A") ? source.media ?? "" : "",
  };
  const paragraphs = [];
  if (source.coreByCalendar) paragraphs.push(source.coreByCalendar[effective.cal]);
  else paragraphs.push(placeholder(source.core, values));
  if (source.track?.[trackName]) paragraphs.push(source.track[trackName]);
  if (source.caseFact) paragraphs.push(source.caseFact);
  return paragraphs;
}

function actDropChoices(P) {
  return P.map((priority) => ({ id: priority, label: content.choices.labels[priority] }));
}

function commitAct(challenge, draftValue) {
  const before = {
    P: [...state.answers.P],
    cal: state.answers.cal,
    msg: state.answers.msg,
    ev: state.answers.ev,
  };
  const action = applyAct(challenge.X, before.P, before.cal, before.msg, draftValue.drop);
  const previous = clone(state.answers.r26);
  state.answers.r26 = { resp: "ACT", drop: action.dropped };
  const details = {
    resp: "ACT",
    drop: action.dropped,
    variant: action.variant,
    challenge: challenge.X,
    before,
  };
  if (previous) {
    for (const item of state.history) {
      if (item.node === NODE_KEYS.r26 && item.status === "active") {
        item.status = "superseded";
        item.supersededBy = (state.history.at(-1)?.seq ?? 0) + 1;
        item.reason = "edit:R2.6";
      }
    }
  }
  recordHistory(NODE_KEYS.r26, details);
  clearDraft();
  state.screen = checkpointPassed(state.checkpoints, content.ui.checkpoints.round2) ? "S13" : "Q2";
  persist();
  render();
}

function renderS12(card) {
  const round2 = currentRound2();
  const { challenge, trackName, effective } = round2;
  if (challenge.X === "X0") {
    const preMortem = content.cards.followUps.X0;
    card.append(make("p", "", preMortem.prompt));
    const choices = preMortem.choices.map((item) => ({
      id: item.id,
      label: item.label,
      panel: item.panel,
    }));
    const value = nodeValue("r26");
    const group = makeChoiceGroup(card, {
      legend: content.ui.copy.whichLinkDoYouThinkIsMostLikelyToHaveBroken,
      choices,
      name: "r26-x0",
      value: value?.weakLink ?? (state.draft?.node === "r26" ? state.draft.value?.weakLink : ""),
      onChange: (selected) => saveDraft("r26", { resp: "X0", drop: null, weakLink: selected }),
    });
    let button;
    button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
      commitAnswer("r26", { resp: "X0", drop: null, weakLink: group.selectedValues() }, NODE_KEYS.r26, "S13");
    });
    group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
    return;
  }

  const paragraphs = followUpText(round2);
  const copy = content.cards.followUps[challenge.X];
  for (const text of paragraphs) appendLabeledParagraph(card, text);
  const alsoOpen = challenge.watch.map((link) => content.choices.labels[link]);
  if (alsoOpen.length) card.append(make("p", "", placeholder(content.ui.copy.dynamicAlsoOpen, { v1: alsoOpen.join("; ") })));
  const variant = actVariant(challenge.X, effective.P, effective.cal, effective.msg);
  const responseChoices = [
    { id: "WATCH", label: content.ui.copy.waitOneCycle, panel: copy.wait },
    {
      id: "ACT",
      label: content.ui.copy.actNow,
      panel: copy.actByVariant?.[variant] ?? copy.act,
    },
  ];
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.response.prompt,
    choices: responseChoices,
    name: "r26-response",
    value: nodeValue("r26")?.resp ?? (state.draft?.node === "r26" ? state.draft.value?.resp : ""),
    onChange: (value) => saveDraft("r26", { resp: value, drop: null }),
  });

  let actionArea = make("div");
  card.append(actionArea);
  const restoredDraft = state.draft?.node === "r26" ? state.draft.value : null;
  let actStageOpen = restoredDraft?.resp === "ACT";
  const updateActionArea = () => {
    actionArea.replaceChildren();
    const response = state.draft?.node === "r26" ? state.draft.value : state.answers.r26;
    if (response?.resp !== "ACT" || !actStageOpen) return;
    const variant = actVariant(challenge.X, effective.P, effective.cal, effective.msg);
    const actionCopy = content.cards.actions[variant];
    if (variant === "ACT-4" || variant === "ACT-5") {
      actionArea.append(make("h2", "", actionCopy.confirmationTitle), make("p", "", actionCopy.confirmation));
      actionArea.append(makeButton(content.ui.copy.confirmChange, () => commitAct(challenge, { drop: null })));
      actionArea.append(makeButton(content.ui.navigation.goBack, () => {
        saveDraft("r26", { resp: "WATCH", drop: null });
        updateActionArea();
      }, "secondary"));
      return;
    }
    const dropChoices = actDropChoices(state.answers.P);
    const groupDrop = makeChoiceGroup(actionArea, {
      legend: placeholder(actionCopy.dropPrompt, { fixPriority: content.choices.labels[({ "X-AWARE":"A", "X-BRAND":"D", "X-TIME":"B", "X-EXEC":"B", "X-FLOW":"C" })[challenge.X]] }),
      choices: dropChoices,
      name: "r26-drop",
      value: response.drop ?? "",
      onChange: (drop) => {
        saveDraft("r26", { resp: "ACT", drop });
        updateActionArea();
      },
    });
    const drop = response.drop;
    if (drop) {
      actionArea.append(make("h2", "", actionCopy.confirmationTitle));
      actionArea.append(make("p", "", placeholder(actionCopy.confirmation, {
        fixPriority: content.choices.labels[({ "X-AWARE":"A", "X-BRAND":"D", "X-TIME":"B", "X-EXEC":"B", "X-FLOW":"C" })[challenge.X]],
        droppedPriority: content.choices.labels[drop],
      })));
      actionArea.append(makeButton(content.ui.copy.confirmChange, () => commitAct(challenge, { drop })));
    }
    groupDrop.inputs.forEach((input) => input.addEventListener("change", () => updateActionArea()));
  };
  group.inputs.forEach((input) => input.addEventListener("change", updateActionArea));
  updateActionArea();

  let continueButton;
  continueButton = makeButton(content.ui.navigation.continue, () => {
    const response = group.selectedValues();
    if (response === "WATCH") {
      commitAnswer("r26", { resp: "WATCH", drop: null }, NODE_KEYS.r26, "S13");
    } else {
      saveDraft("r26", { resp: "ACT", drop: null });
      actStageOpen = true;
      updateActionArea();
      continueButton.disabled = true;
    }
  });
  continueButton.disabled = !group.isValid() || actStageOpen;
  group.inputs.forEach((input) => input.addEventListener("change", () => {
    actStageOpen = false;
    continueButton.disabled = !group.isValid();
    updateChoiceButton(continueButton, group);
    updateActionArea();
  }));
  card.append(continueButton);
}

function renderS13(card) {
  const round2 = currentRound2();
  card.append(make("p", "notice", content.ui.copy.round2IsAboutToLock));
  const commitments = section(card, content.ui.copy.round2Commitments);
  commitments.append(make("p", "", placeholder(content.ui.copy.dynamicPriorities, { v1: priorityList(round2.effective.P) })));
  commitments.append(make("p", "", placeholder(content.ui.copy.dynamicCalendar, { v1: sentenceLabel(answerLabel(round2.effective.cal)) })));
  commitments.append(make("p", "", placeholder(content.ui.copy.dynamicMessage, { v1: sentenceLabel(answerLabel(round2.effective.msg)) })));
  commitments.append(make("p", "", placeholder(content.ui.copy.dynamicEvidence, { v1: sentenceLabel(answerLabel(round2.effective.ev)) })));
  commitments.append(make("p", "", placeholder(content.ui.copy.responseSummary, {
    flag: round2.challenge.X === "X0" ? content.ui.copy.structuredPreMortemLower : round2LinkLabel(round2.challenge.X),
    response: round2ResponseResult()?.text ?? content.ui.copy.choiceRecorded,
  })));
  if (round2.action?.dropped) {
    commitments.append(make("p", "", placeholder(content.ui.copy.round2Swap, {
      v1: content.choices.labels[round2.action.dropped],
      v2: content.choices.labels[round2.action.added],
    })));
  }
  const media = mediaPhasing(round2.effective.cal, round2.effective.P, {
    anchorMonths: 6,
    quietMonths: 6,
    uncommittedMedia: content.ledger.inputs.media,
  });
  const mediaDetails = document.createElement("details");
  mediaDetails.className = "details-panel";
  mediaDetails.append(make("summary", "", content.ui.copy.viewMediaSpending));
  const mediaBody = make("div", "details-content");
  if (round2.effective.cal === "ALIGN") {
    makeTable(
      mediaBody,
      content.ui.copy.mediaAllocationAnnualEquivalentIllustration,
      [content.ui.copy.allocation, content.ui.copy.anchorMonthsEven, content.ui.copy.quietMonthsOdd, content.ui.copy.perAnchorMonth, content.ui.copy.perQuietMonth],
      [[
        round2.effective.P.includes("A") ? content.ui.copy.sixtyForty : content.ui.copy.twoThirdsOneThird,
        formatCurrency(media.totals.anchor),
        formatCurrency(media.totals.quiet),
        formatCurrency(media.perMonth.anchor),
        formatCurrency(media.perMonth.quiet),
      ]],
    );
    mediaBody.append(make("p", "", round2.effective.P.includes("A")
      ? content.ui.copy.quietMediaTwoThirds
      : content.ui.copy.quietMediaHalf));
  } else {
    makeTable(
      mediaBody,
      content.ui.copy.mediaAllocationAnnualEquivalentIllustration,
      [content.ui.copy.allocation, content.ui.copy.flatMonthlyMedia, content.ui.copy.annualEquivalentMedia],
      [[content.ui.copy.flat, formatCurrency(media.perMonth.anchor), formatCurrency(media.uncommittedMedia)]],
    );
    mediaBody.append(make("p", "", content.ui.copy.quietMediaEqual));
  }
  mediaBody.append(make("p", "progress-detail", content.ui.copy.thisAnnualEquivalentIllustrationAssumesThePatternRanAllYearAfterYouChooseTh));
  mediaDetails.append(mediaBody);
  commitments.append(mediaDetails);
  const watchShown = round2.complicationResult?.watchShown ?? [];
  if (watchShown.length === 0) {
    commitments.append(make("p", "", content.ui.lock.nothingElse));
  } else {
    const lines = section(commitments, content.ui.copy.alsoOpenNotAddressed);
    for (const link of watchShown) {
      const line = content.cards.alsoOpenLines[link];
      lines.append(make("p", "", typeof line === "string" ? line : line[round2.effective.cal]));
    }
  }
  if (state.locks.r2) {
    card.append(makeButton(content.ui.copy.continueToRound3, () => setScreen("S14")));
  } else {
    card.append(makeButton(content.ui.copy.continueToRound3, () => {
      state.locks.r2 = true;
      recordHistory("LOCK-R2", {
        P: round2.effective.P,
        cal: round2.effective.cal,
        msg: round2.effective.msg,
        ev: round2.effective.ev,
      });
      state.screen = "S14";
      persist();
      render();
    }));
    card.append(makeButton(content.ui.navigation.goBack, () => setScreen("S12"), "secondary"));
  }
}

function complicationText(round2, outcome) {
  const contentKey = outcome?.C3;
  const source = content.cards.complications[contentKey];
  if (!source) throw new TypeError(`CONTENT MISSING: ${contentKey}`);
  const effective = round2.effective;
  const values = {
    calendar: source.calendar?.[effective.cal] ?? "",
    message: source.message?.[effective.msg] ?? "",
    media: effective.cal === "ALIGN" && !effective.P.includes("A") ? source.media ?? "" : "",
  };
  const contextLine = content.cards.complications.context[outcome.context];
  if (!contextLine) throw new TypeError(`CONTENT MISSING: context ${outcome.context}`);
  const paragraphs = [placeholder(contextLine, {
    droppedPriority: content.choices.labels[round2.action?.dropped] ?? content.ui.copy.aPriority,
  })];
  if (source.coreByCalendar) paragraphs.push(source.coreByCalendar[effective.cal]);
  else paragraphs.push(placeholder(source.core, values));
  if (source.track?.[round2.trackName]) paragraphs.push(source.track[round2.trackName]);
  if (source.caseFact) paragraphs.push(source.caseFact);
  return paragraphs;
}

function renderS14(card) {
  const round2 = currentRound2();
  const outcome = round2.complicationResult;
  const headline = content.cards.complications[outcome.C3].headline;
  card.append(make("h2", "", headline));
  for (const text of complicationText(round2, outcome)) appendLabeledParagraph(card, text);
  if (outcome.openRisks.length) {
    card.append(make("p", "", placeholder(content.ui.copy.dynamicAlsoStillOpen, { v1: outcome.openRisks.map((link) => content.choices.labels[link]).join("; ") })));
  }
  const choices = content.cards.r31Responses[outcome.C3];
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.r31.prompt,
    choices,
    name: "r31",
    value: nodeValue("r31"),
    onChange: (value) => saveDraft("r31", value),
  });
  let button;
  button = addContinue(card, content.ui.navigation.continue, group.isValid(), () => {
    commitAnswer("r31", group.selectedValues(), NODE_KEYS.r31, "S15");
  });
  group.inputs.forEach((input) => input.addEventListener("change", () => updateChoiceButton(button, group)));
}

function displayOriginalProjection(parent) {
  const details = document.createElement("details");
  details.className = "details-panel";
  details.append(make("summary", "", content.ui.round3.originalProjectionTitle));
  const inside = make("div", "details-content");
  inside.append(make("p", "info-panel", lensReminder(
    state.answers.lens,
    confirmedRec(state.answers),
    content.ledger,
  )));
  makeTable(
    inside,
    content.ui.copy.originalProjectionFullYearAssumptionsUnchangedNotReForecast,
    [content.ui.copy.measure, ...content.ui.ledger.columns],
    content.ui.ledger.rows.map((row) => [row.label, ...row.values]),
    { firstColumnHeader: true },
  );
  details.append(inside);
  parent.append(details);
}

function actionChoices() {
  const current = confirmedRec(state.answers);
  return content.choices.nodes.r32.choices.filter((choice) =>
    !choice.id.startsWith("REVISE-") || choice.id !== `REVISE-${current}`,
  );
}

function renderR32Subchoice(parent, actionValue, onChanged) {
  if (!actionValue?.action) return { valid: false, value: null };
  const action = actionValue.action;
  if (action === "RETAIN") return { valid: true, value: { action, sub: null } };
  if (action.startsWith("REVISE-")) {
    parent.append(make("h2", "", content.ui.round3.confirmRevisionTitle));
    parent.append(make("p", "", content.ui.round3.confirmRevision));
    return { valid: true, value: { action, sub: null, confirmed: true } };
  }

  if (action === "REFINE-CAL" || action === "REFINE-MSG") {
    const nodeKey = action === "REFINE-CAL" ? "calendar" : "message";
    const choices = content.choices.nodes[nodeKey].choices.map((choice) => ({
      ...choice,
      label: `${choice.label}${choice.id === state.answers.cal && action === "REFINE-CAL" ? content.ui.copy.current : choice.id === state.answers.msg && action === "REFINE-MSG" ? content.ui.copy.current : ""}`,
    }));
    const currentValue = actionValue.sub;
    const group = makeChoiceGroup(parent, {
      legend: action === "REFINE-CAL" ? content.ui.copy.chooseTheCalendarForTheRemainingMonths : content.ui.copy.chooseTheMessagePostureForTheRemainingPeriod,
      choices,
      name: "r32-sub",
      value: currentValue,
      onChange: (value) => {
        saveDraft("r32", { action, sub: value });
        onChanged();
      },
    });
    return { valid: group.isValid(), value: group.isValid() ? { action, sub: group.selectedValues() } : null };
  }

  const round2State = currentRound2();
  const choices = content.choices.nodes.priorities.choices.map((choice) => ({
    ...choice,
    label: `${choice.label}${round2State.effective.P.includes(choice.id) ? content.ui.copy.current : ""}`,
  }));
  const group = makeChoiceGroup(parent, {
    legend: content.ui.copy.chooseExactlyTwoPrioritiesForTheRemainingPeriod,
    choices,
    name: "r32-sub-P",
    value: actionValue.sub,
    multiple: true,
    min: 2,
    max: 2,
    onChange: (value) => {
      saveDraft("r32", { action, sub: value });
      onChanged();
    },
  });
  return { valid: group.isValid(), value: group.isValid() ? { action, sub: group.selectedValues() } : null };
}

function renderS15(card) {
  const round2 = currentRound2();
  const reminders = section(card, content.ui.copy.beforeYouAuthorize);
  reminders.append(make("p", "", placeholder(content.ui.copy.currentPlanReminder, {
    rec: chosenOptionLabel(confirmedRec(state.answers)),
    P: priorityList(round2.effective.P),
    cal: sentenceLabel(answerLabel(round2.effective.cal)),
    msg: sentenceLabel(answerLabel(round2.effective.msg)),
  })));
  const considered = Object.values(content.cards.r31Responses).flat().find((item) => item.id === state.answers.r31);
  reminders.append(make("p", "", placeholder(content.ui.copy.consideredReminder, {
    response: sentenceLabel(considered.label),
  })));
  const guidance = content.ui.copy.authorizationGuidance[considered.id];
  if (guidance) reminders.append(make("p", "info-panel", guidance));
  displayOriginalProjection(card);
  card.append(make("p", "", content.ui.round3.whyOne));
  const actionValue = state.draft?.node === "r32" ? state.draft.value : state.answers.r32;
  const group = makeChoiceGroup(card, {
    legend: content.choices.nodes.r32.prompt,
    choices: actionChoices(),
    name: "r32-action",
    value: actionValue?.action ?? "",
    onChange: (action) => {
      saveDraft("r32", {
        action,
        sub: actionValue?.action === action ? actionValue.sub : null,
      });
      renderR32Dynamic();
    },
  });
  const dynamic = make("div");
  card.append(dynamic);
  let actionButton;
  const renderR32Dynamic = () => {
    dynamic.replaceChildren();
    const selectedAction = group.selectedValues();
    const draft = state.draft?.node === "r32" ? state.draft.value : state.answers.r32;
    if (!selectedAction) {
      if (actionButton) actionButton.disabled = true;
      return;
    }
    if (selectedAction.startsWith("REFINE-")) {
      const panelText = selectedAction === "REFINE-CAL"
        ? content.ui.round3.refineCalendar
        : selectedAction === "REFINE-MSG"
          ? content.ui.round3.refineMessage
          : content.ui.round3.refinePriorities;
      dynamic.append(make("p", "info-panel", panelText));
    }
    const sub = renderR32Subchoice(dynamic, { action: selectedAction, sub: draft?.action === selectedAction ? draft.sub : null }, renderR32Dynamic);
    const authorization = sub.value
      ? authorizationStatus(sub.value, {
        rec: confirmedRec(state.answers),
        P: round2.effective.P,
        cal: round2.effective.cal,
        msg: round2.effective.msg,
      })
      : { valid: false, reason: "missing" };
    if (!authorization.valid) {
      dynamic.append(make("p", "notice", authorization.reason === "same"
        ? content.ui.copy.sameAsCurrent
        : content.ui.copy.missingRefinement));
    }
    actionButton.disabled = !authorization.valid;
    actionButton.textContent = selectedAction.startsWith("REVISE-")
      ? content.ui.copy.confirmRevision
      : selectedAction === "RETAIN"
        ? content.ui.copy.authorizeThisAction
        : content.ui.navigation.continue;
    actionButton.onclick = () => {
      if (!authorization.valid || !sub.value) return;
      commitAnswer("r32", sub.value, NODE_KEYS.r32, "S16");
    };
  };
  actionButton = makeButton(content.ui.navigation.continue, () => {}, "");
  actionButton.disabled = !actionValue?.action;
  card.append(actionButton);
  group.inputs.forEach((input) => input.addEventListener("change", renderR32Dynamic));
  renderR32Dynamic();
}

function developmentChoices() {
  const round2 = currentRound2();
  const outcome = round3Outcome();
  const eventId = `E2-${round2.trackName}`;
  const response = state.answers.r26.resp === "WATCH" ? content.ui.copy.holdCourseAndWatchIt : state.answers.r26.resp === "ACT" ? content.ui.copy.actNow : content.ui.copy.structuredPreMortemSentence;
  const followUpLabel = round2.challenge.X === "X0"
    ? content.ui.copy.nothingPreMortem
    : content.cards.followUps[round2.challenge.X].headline;
  const responseLabel = state.answers.r26.resp === "ACT"
    ? round2ResponseResult()?.text ?? response
    : response;
  return [
    { id: eventId, label: content.cards.eventHeadlines[round2.trackName] },
    { id: round2.challenge.X, label: followUpLabel },
    { id: `RESPONSE-${state.answers.r26.resp}`, label: responseLabel },
    { id: outcome.C3, label: content.cards.complications[outcome.C3].headline },
  ];
}

function defenseDraftValue() {
  const value = state.draft?.node === "defense" ? state.draft.value : state.answers.defense;
  return { fact: value?.fact ?? "", dev: value?.dev ?? "", text: value?.text ?? "" };
}

function wordCount(text) {
  return text.trim().match(/\S+/g)?.length ?? 0;
}

function limitWords(text) {
  const words = text.match(/\S+/g) ?? [];
  if (words.length <= 150) return { text, trimmed: false };
  const lines = text.trim().split(/\s+/).slice(0, 150);
  return { text: lines.join(" "), trimmed: true };
}

function renderS16(card) {
  const round2 = currentRound2();
  const authorization = authorizationStatus(state.answers.r32, {
    rec: confirmedRec(state.answers),
    P: round2.effective.P,
    cal: round2.effective.cal,
    msg: round2.effective.msg,
  });
  if (!authorization.valid) {
    card.append(make("p", "notice", authorization.reason === "same"
      ? content.ui.copy.sameAsCurrent
      : authorization.reason === "confirmation"
        ? content.ui.copy.authorizedActionRequired
        : content.ui.copy.missingRefinementRecovery));
    card.append(makeButton(content.ui.copy.returnToStep2, () => setScreen("S15")));
    return;
  }
  const authorized = section(card, content.ui.copy.authorizedAction);
  authorized.append(make("p", "", placeholder(content.ui.copy.dynamicYouAuthorized, {
    v1: authorizationLabel(state.answers.r32),
  })));
  authorized.append(make("p", "", r32Sentence()));
  displayOriginalProjection(card);
  card.append(make("p", "", content.ui.defense.prompt));

  const defense = defenseDraftValue();
  const factSelect = document.createElement("select");
  factSelect.id = "defense-fact";
  factSelect.append(new Option(content.ui.copy.chooseACaseFactOrCalculation, ""));
  for (const choice of content.choices.nodes.defenseFacts.choices) {
    factSelect.append(new Option(choice.label, choice.id));
  }
  factSelect.value = defense.fact;
  createField(content.ui.defense.caseFactLabel, card, factSelect);

  const devSelect = document.createElement("select");
  devSelect.id = "defense-development";
  devSelect.append(new Option(content.ui.copy.chooseADevelopmentFromYourPath, ""));
  for (const choice of developmentChoices()) devSelect.append(new Option(choice.label, choice.id));
  devSelect.value = defense.dev;
  createField(content.ui.defense.developmentLabel, card, devSelect);

  const textArea = document.createElement("textarea");
  textArea.id = "defense-text";
  textArea.maxLength = 10000;
  textArea.value = defense.text;
  textArea.setAttribute("aria-describedby", "word-counter defense-limit");
  createField(content.ui.defense.textLabel, card, textArea);
  const counter = make("span", "word-counter", content.ui.defense.wordCount.replace("{count}", String(wordCount(defense.text))));
  counter.id = "word-counter";
  counter.setAttribute("aria-live", "off");
  card.append(counter);
  const counterStatus = make("span", "visually-hidden");
  counterStatus.setAttribute("aria-live", "polite");
  counterStatus.setAttribute("aria-atomic", "true");
  counterStatus.textContent = counter.textContent;
  card.append(counterStatus);
  card.append(make("p", "progress-detail", content.ui.copy.noMinimumWordCountANonWhitespaceCharacterIsRequiredTheMaximumIs150Whitespac));
  const limitNotice = make("p", "notice", content.ui.copy.textPast150WordsIsRemovedYourEarlierWritingStaysOnThisDevice);
  limitNotice.id = "defense-limit";
  limitNotice.hidden = true;
  card.append(limitNotice);
  const updateDefense = () => {
    const value = { fact: factSelect.value, dev: devSelect.value, text: textArea.value };
    saveDefenseDraft(value);
    counter.textContent = content.ui.defense.wordCount.replace("{count}", String(wordCount(value.text)));
    if (wordCount(value.text) > 150) counter.textContent = content.ui.errors.wordLimit;
    counterStatus.textContent = counter.textContent;
  };
  factSelect.addEventListener("change", () => {
    updateDefense();
    drawSubmit();
  });
  devSelect.addEventListener("change", () => {
    updateDefense();
    drawSubmit();
  });
  textArea.addEventListener("input", () => {
    const limited = limitWords(textArea.value);
    if (limited.trimmed) {
      textArea.value = limited.text;
      limitNotice.hidden = false;
    }
    counter.textContent = content.ui.defense.wordCount.replace("{count}", String(wordCount(textArea.value)));
    drawSubmit();
    updateDefense();
  });
  const submitArea = make("div");
  card.append(submitArea);
  const drawSubmit = () => {
    submitArea.replaceChildren();
    const valid = factSelect.value && devSelect.value && wordCount(textArea.value) > 0 && wordCount(textArea.value) <= 150;
    const submit = makeButton(content.ui.defense.submit, () => {
      if (!valid) {
        submitArea.append(make("p", "error-panel", content.ui.errors.required));
        return;
      }
      const defenseAnswer = { fact: factSelect.value, dev: devSelect.value, text: textArea.value };
      const completion = completionStatus(
        { ...state.answers, defense: defenseAnswer },
        { ...state.locks, r3: true },
      );
      if (!completion.complete) {
        submitArea.append(make("p", "error-panel", `${content.ui.errors.required} ${completion.missing.join(", ")}`));
        return;
      }
      const confirmBox = make("div", "notice");
      confirmBox.append(make("p", "", content.ui.defense.submitConfirmation));
      factSelect.disabled = true;
      devSelect.disabled = true;
      textArea.disabled = true;
      confirmBox.append(makeButton(content.ui.copy.confirmAndFinish, () => {
        state.answers.defense = defenseAnswer;
        recordHistory(NODE_KEYS.defense, state.answers.defense);
        state.locks.r3 = true;
        state.completion.completedAt ??= now();
        state.completion.receiptIssued = true;
        state.completion.receipt ??= buildReceipt(state);
        state.screen = "S17";
        clearDraft();
        persist();
        render();
      }));
      confirmBox.append(makeButton(content.ui.navigation.goBack, () => {
        factSelect.disabled = false;
        devSelect.disabled = false;
        textArea.disabled = false;
        drawSubmit();
      }, "secondary"));
      submitArea.append(confirmBox);
    });
    submit.disabled = !valid;
    submitArea.append(submit);
  };
  drawSubmit();
}

function renderS17(card) {
  renderReceiptSection(card);
  const outcome = round3Outcome();
  const finalPlan = finalRound3State();
  const finalDecision = section(card, content.ui.copy.yourFinalDecision);
  if (finalPlan.rec === state.answers.initialRec) {
    finalDecision.append(make("p", "", placeholder(content.ui.copy.finalRecommendation, {
      recommendation: chosenOptionLabel(finalPlan.rec),
    })));
  } else {
    finalDecision.append(make("p", "", placeholder(content.ui.copy.finalRecommendationChanged, {
      initial: chosenOptionLabel(state.answers.initialRec),
      final: chosenOptionLabel(finalPlan.rec),
    })));
  }
  finalDecision.append(make("p", "", placeholder(content.ui.copy.dynamicYouAuthorized, {
    v1: authorizationLabel(state.answers.r32),
  })));
  finalDecision.append(make("p", "", r32Sentence()));
  finalDecision.append(make("p", "", placeholder(content.ui.copy.finalPlanSummary, {
    P: priorityList(finalPlan.P),
    cal: sentenceLabel(answerLabel(finalPlan.cal)),
    msg: sentenceLabel(answerLabel(finalPlan.msg)),
  })));

  const takeaway = section(card, content.ui.copy.takeaway);
  takeaway.append(make("p", "", content.cards.debrief.takeaways[outcome.C3]));
  displayOriginalProjection(card);

  const review = make("div", "review-controls");
  const decisionPath = document.createElement("details");
  decisionPath.className = "details-panel";
  decisionPath.append(make("summary", "", content.ui.copy.reviewMyChoices));
  const historyBody = make("div", "details-content");
  const pathRows = state.history.map((item) => [
    content.ui.historyLabels[item.node] ?? content.ui.copy.choiceRecorded,
    historyValue(item),
    item.status === "superseded" ? content.ui.copy.earlierAnswer : content.ui.copy.currentAnswer,
  ]);
  if (pathRows.length) makeTable(historyBody, content.ui.copy.recordedChoicesAndChanges, [content.ui.copy.step, content.ui.copy.choice, content.ui.copy.status], pathRows);
  historyBody.append(make("h3", "", content.ui.copy.finalDefense));
  historyBody.append(make("p", "", state.answers.defense.text));
  decisionPath.append(historyBody);
  review.append(decisionPath, makeButton(content.ui.receipt.download, downloadRecord, "secondary"));
  card.append(review);
}

function renderReceiptSection(parent) {
  const finish = section(parent, content.ui.finishInCanvas.title);
  const steps = make("ol");
  for (const step of content.ui.finishInCanvas.steps) steps.append(make("li", "", step));
  finish.append(steps, make("p", "", content.ui.creditNotice));
  const receiptSection = section(parent, content.ui.receipt.title);
  const receipt = state.completion.receipt ?? buildReceipt(state);
  const receiptText = document.createElement("textarea");
  receiptText.className = "receipt-text";
  receiptText.readOnly = true;
  receiptText.setAttribute("aria-label", content.ui.copy.completionReceiptText);
  receiptText.value = receipt;
  receiptSection.append(receiptText);
  receiptSection.append(make("p", "privacy-note", content.ui.receipt.note));
  receiptSection.append(make("p", "privacy-note", content.ui.privacy));
  const copyStatus = make("p", "progress-detail");
  copyStatus.setAttribute("role", "status");
  copyStatus.setAttribute("aria-live", "polite");
  const copyButton = makeButton(content.ui.receipt.copy, async () => {
    try {
      await navigator.clipboard.writeText(receipt);
      copyStatus.textContent = content.ui.receipt.copied;
    } catch {
      receiptText.focus();
      receiptText.select();
      copyStatus.textContent = content.ui.receipt.copyFallback;
    }
  });
  receiptSection.append(copyButton, copyStatus);
  receiptSection.append(make("p", "progress-detail", content.ui.receipt.downloadNote));
}

function round2LinkLabel(challengeId) {
  if (challengeId === "X0") return content.ui.copy.nothingPreMortem;
  const link = challengeId.slice(2);
  return content.choices.labels[link] ?? challengeId;
}

function downloadRecord() {
  const lines = [
    content.ui.copy.recordTitle,
    content.ui.copy.recordNote,
    placeholder(content.ui.copy.dynamicVersion, { v1: state.appVersion }),
    placeholder(content.ui.copy.dynamicCompletedAt, { v1: state.completion.completedAt }),
    "",
    content.ui.copy.recordHistory,
    ...state.history.map((item) => `${item.seq}. ${content.ui.historyLabels[item.node] ?? content.ui.copy.choiceRecorded}: ${historyValue(item)}${item.status === "superseded" ? ` (${content.ui.copy.earlierAnswer})` : ""}`),
    "",
    content.ui.copy.recordDefense,
    state.answers.defense.text,
  ];
  const file = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = "plnj-simulation-record.txt";
  link.click();
  URL.revokeObjectURL(link.href);
}

function resetActivity() {
  if (defenseSaveTimer !== null) {
    window.clearTimeout(defenseSaveTimer);
    defenseSaveTimer = null;
  }
  persist();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    storageAvailable = false;
    startOverOpen = false;
    resetError = content.ui.storage.clearFailed;
    render();
    return;
  }
  state = null;
  updateBeforeUnload();
  savedRaw = null;
  invalidSavedState = false;
  startOverOpen = false;
  showingWelcome = true;
  resetError = "";
  render();
}

function renderStartOver(parent) {
  if (resetError) parent.append(make("p", "error-panel", resetError));
  if (!state && !invalidSavedState) return;
  if (!startOverOpen) {
    parent.append(makeButton(content.ui.navigation.startOver, () => {
      startOverOpen = true;
      render();
    }, "secondary"));
    return;
  }
  const sectionElement = make("section", "notice");
  sectionElement.append(make("p", "", content.ui.storage.startOverPrompt));
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.id = "start-over-confirmation";
  createField(content.ui.copy.confirmation, sectionElement, input);
  const confirm = makeButton(content.ui.copy.confirmStartOver, () => {
    if (input.value === "start over") resetActivity();
    else sectionElement.append(make("p", "error-panel", content.ui.copy.startOverError));
  });
  confirm.disabled = true;
  input.addEventListener("input", () => {
    confirm.disabled = input.value !== "start over";
  });
  sectionElement.append(confirm, makeButton(content.ui.navigation.goBack, () => {
    startOverOpen = false;
    render();
  }, "secondary"));
  parent.append(sectionElement);
}

function backScreen(screen) {
  if (state.checkpointReturn && ["Q1", "Q2"].includes(screen)) return;
  if (screen === "S6" && state.locks.r1) {
    setScreen("S7");
    return;
  }
  if (screen === "S13" && state.locks.r2) {
    setScreen("S14");
    return;
  }
  const map = {
    Q1: "S1", S2: "S1", S3: "S2", S4: "S3", S5: "S4", S5b: "S5", S6: "S5",
    S7: "S6", S8: "S7", S9: "S8", S10: "S9", S11: "S10", S12: "S11", Q2: "S12", S13: "S12",
    S14: "S13", S15: "S14", S16: "S15",
  };
  const target = map[screen];
  if (!target) return;
  setScreen(target);
}

function renderInvalidState() {
  screenRegion.replaceChildren();
  const panelElement = make("section", "error-panel");
  panelElement.setAttribute("role", "alert");
  panelElement.append(make("h1", "", content.ui.storage.invalid));
  panelElement.append(make("p", "", content.ui.copy.savedProgressIsIncompatibleOrIncompleteNoPartOfItWasRestored));
  renderStartOver(panelElement);
  screenRegion.append(panelElement);
  app.setAttribute("aria-busy", "false");
}

function render() {
  if (!content) return;
  if (invalidSavedState && !state) {
    renderInvalidState();
    return;
  }
  const screen = showingWelcome ? "S0" : state?.screen ?? "S0";
  screenRegion.replaceChildren();
  const card = renderFrame(screen);
  if (screen === "S0") renderS0(card);
  else {
    const renderers = {
      S1: renderS1, Q1: (parent) => renderCheckpoint(parent, 1), S2: renderS2, S3: renderS3, S4: renderS4, S5: renderS5,
      S5b: renderS5b, S6: renderS6, S7: renderS7, S8: renderS8, S9: renderS9,
      S10: renderS10, S11: renderS11, S12: renderS12, Q2: (parent) => renderCheckpoint(parent, 2), S13: renderS13, S14: renderS14,
      S15: renderS15, S16: renderS16, S17: renderS17,
    };
    renderers[screen](card);
    if (!["S5", "S5b", "S6", "S13", "S17"].includes(screen)) {
      const footer = make("div", "navigation-row");
      const back = makeButton(content.ui.navigation.back, () => backScreen(screen), "secondary");
      if (state.checkpointReturn && ["Q1", "Q2"].includes(screen)) back.disabled = true;
      footer.append(back);
      card.append(footer);
    }
    renderStartOver(card);
  }
  app.setAttribute("aria-busy", "false");
  const heading = screenRegion.querySelector("h1");
  if (heading) announceHeading(heading);
}

async function initialize() {
  try {
    const files = await Promise.all([
      loadJson("content/choices.json"),
      loadJson("content/cards.json"),
      loadJson("content/ledger.json"),
      loadJson("content/ui.json"),
    ]);
    content = { choices: files[0], cards: files[1], ledger: files[2], ui: files[3] };
    validateContent(files);
  } catch {
    showContentError();
    return;
  }

  initializeStorage();
  loadSavedState();
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY && event.newValue !== event.oldValue) {
      otherTabOpen = true;
      render();
    }
  });
  window.addEventListener("popstate", () => {
    window.history.pushState({ plnj: true }, "", window.location.href);
    if (state && !state.locks.r3) backScreen(state.screen);
  });
  window.history.pushState({ plnj: true }, "", window.location.href);
  render();
}

initialize();