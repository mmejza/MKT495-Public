export const LINKS = ["AWARE", "EXEC", "FLOW", "BRAND", "TIME"];

const TRACKS = {
  O1: "CUT",
  O2: "CONS",
  O3: "TRADE",
};

const TRACK_ORDER = {
  TRADE: ["FLOW", "AWARE", "TIME", "EXEC", "BRAND"],
  CONS: ["EXEC", "BRAND", "TIME", "AWARE", "FLOW"],
  CUT: ["AWARE", "EXEC", "TIME", "FLOW", "BRAND"],
};

const FIX_PRIORITY = {
  "X-AWARE": "A",
  "X-BRAND": "D",
  "X-TIME": "B",
  "X-EXEC": "B",
  "X-FLOW": "C",
};

export function confirmedRec(answers) {
  if (!answers.initialRec) return null;
  if (!answers.r15 || answers.r15 === "KEEP") return answers.initialRec;
  const match = /^SW-(O[123])$/.exec(answers.r15);
  return match ? match[1] : null;
}

export function track(recommendation) {
  return TRACKS[recommendation] ?? null;
}

export function protection(P, cal, msg, ev) {
  const priorities = new Set(P);
  return {
    AWARE: priorities.has("A"),
    EXEC: priorities.has("B"),
    FLOW: priorities.has("C") || ev === "SELL",
    BRAND: msg === "PREM" || (msg === "MIX" && priorities.has("D")),
    TIME: cal === "KEEP" || (cal === "ALIGN" && priorities.has("B")),
  };
}

export function followUp(trackName, protectedLinks) {
  const order = TRACK_ORDER[trackName];
  if (!order) throw new RangeError(`Unknown track: ${trackName}`);
  const unprotected = order.filter((link) => !protectedLinks[link]);
  const link = unprotected[0] ?? null;
  return {
    X: link ? `X-${link}` : "X0",
    link,
    watch: link ? unprotected.slice(1) : [],
    protectionBefore: { ...protectedLinks },
  };
}

export function actVariant(X, P, cal, msg) {
  const fix = FIX_PRIORITY[X];
  if (!fix) throw new RangeError(`No action is available for ${X}`);
  const hasFix = P.includes(fix);
  if (X === "X-BRAND" && msg === "DEAL" && hasFix) return "ACT-4";
  if (X === "X-TIME" && cal === "OVERLAP" && hasFix) return "ACT-5";
  if (hasFix) throw new RangeError(`Unexpected already-funded fix for ${X}`);
  if (X === "X-BRAND" && msg === "DEAL") return "ACT-2";
  if (X === "X-TIME" && cal === "OVERLAP") return "ACT-3";
  return "ACT-1";
}

export function applyAct(X, P, cal, msg, drop) {
  const variant = actVariant(X, P, cal, msg);
  const added = FIX_PRIORITY[X];
  const nextP = [...P];
  let dropped = null;
  let nextCal = cal;
  let nextMsg = msg;

  if (variant === "ACT-4") {
    nextMsg = "MIX";
  } else if (variant === "ACT-5") {
    nextCal = "ALIGN";
  } else {
    if (!drop || !P.includes(drop)) {
      throw new RangeError("Choose one of the current priorities to put on hold");
    }
    dropped = drop;
    nextP.splice(nextP.indexOf(drop), 1);
    nextP.push(added);
    if (variant === "ACT-2") nextMsg = "MIX";
    if (variant === "ACT-3") nextCal = "ALIGN";
  }

  return {
    variant,
    P: nextP,
    cal: nextCal,
    msg: nextMsg,
    added: variant === "ACT-4" || variant === "ACT-5" ? null : added,
    dropped,
  };
}

export function complication(
  trackName,
  protectionAfterResponse,
  followUpResult,
  response,
  dropped,
) {
  const order = TRACK_ORDER[trackName];
  if (!order) throw new RangeError(`Unknown track: ${trackName}`);
  const before = followUpResult.protectionBefore;
  if (!before) throw new TypeError("followUpResult must include protectionBefore");
  const isAct = response === "ACT" || response?.resp === "ACT";
  const watchBefore = [...(followUpResult.watch ?? [])];
  const watchShown = watchBefore.filter((link) => !protectionAfterResponse[link]);
  const openedByDrop = isAct
    ? order.filter((link) => before[link] && !protectionAfterResponse[link])
    : [];
  const open = order.filter((link) => !protectionAfterResponse[link]);
  const link = open[0] ?? null;
  const C3 = link ? `C3-${link}` : "C3-HOLD";
  const openRisks = link ? open.slice(1) : [];
  let context;

  if (!isAct && link) context = "ESCALATED";
  else if (!isAct) context = "X0";
  else if (!link) context = "RESOLVED";
  else if (watchShown.includes(link)) context = "CARRIED";
  else if (openedByDrop.includes(link)) context = "OPENED";
  else context = "CARRIED";

  return {
    C3,
    link,
    watchBefore,
    watchShown,
    openedByDrop,
    openRisks,
    context,
    dropped: dropped ?? response?.dropped ?? null,
  };
}

export function mediaPhasing(
  cal,
  P,
  { anchorMonths = 6, quietMonths = 6, uncommittedMedia = 500_000 } = {},
) {
  if (
    !Number.isInteger(anchorMonths) ||
    !Number.isInteger(quietMonths) ||
    anchorMonths < 0 ||
    quietMonths < 0 ||
    anchorMonths + quietMonths === 0
  ) {
    throw new RangeError("Remaining anchor and quiet months must be non-negative integers with a positive total");
  }
  if (!Number.isFinite(uncommittedMedia) || uncommittedMedia < 0) {
    throw new RangeError("Uncommitted media must be a non-negative number");
  }

  const aligned = cal === "ALIGN";
  const awareness = new Set(P).has("A");
  const anchorWeight = !aligned ? 1 : awareness ? 3 : 2;
  const quietWeight = !aligned ? 1 : awareness ? 2 : 1;
  const totalWeight = anchorMonths * anchorWeight + quietMonths * quietWeight;
  const perAnchorMonth = (uncommittedMedia * anchorWeight) / totalWeight;
  const perQuietMonth = (uncommittedMedia * quietWeight) / totalWeight;

  return {
    weights: { anchor: anchorWeight, quiet: quietWeight },
    months: { anchor: anchorMonths, quiet: quietMonths },
    uncommittedMedia,
    perMonth: { anchor: perAnchorMonth, quiet: perQuietMonth },
    totals: {
      anchor: perAnchorMonth * anchorMonths,
      quiet: perQuietMonth * quietMonths,
    },
    ratio: perQuietMonth / perAnchorMonth,
  };
}

export function perMonthSpend(trackName, cal, ledger) {
  const budget = ledger?.tracks?.[trackName];
  if (!budget) throw new RangeError(`Missing ledger budget for ${trackName}`);
  const months = cal === "OVERLAP" ? 12 : 6;
  const consumer = budget.consumer / months;
  const trade = budget.trade / months;
  return { consumer, trade, combined: consumer + trade, months };
}

export function invalidate(answers, editedNode, previousAnswers = answers) {
  const next = structuredClone(answers);
  const superseded = [];
  const clear = (keys) => {
    for (const key of keys) {
      if (next[key] !== undefined && next[key] !== null) {
        superseded.push(key);
        delete next[key];
      }
    }
  };

  if (editedNode === "initialRec") {
    clear(["r13", "r14", "r14CardViewed", "r15", "r15b", "r15Evidence", "confirmedRec"]);
  } else if (editedNode === "r14") {
    next.r14CardViewed = false;
    clear(["r15", "r15b", "r15Evidence"]);
  } else if (editedNode === "r15") {
    if (previousAnswers.r15 !== next.r15) clear(["r15b"]);
    if (next.r15 === "KEEP") {
      clear(["r15b"]);
      next.confirmedRec = next.initialRec;
    } else {
      delete next.confirmedRec;
      if (next.r15b) clear(["r15b"]);
    }
  } else if (["P", "cal", "msg", "ev"].includes(editedNode) && next.r26) {
    const oldTrack = track(confirmedRec(previousAnswers));
    const oldProtection = protection(previousAnswers.P, previousAnswers.cal, previousAnswers.msg, previousAnswers.ev);
    const oldX = followUp(oldTrack, oldProtection).X;
    const newTrack = track(confirmedRec(next));
    const newX = followUp(newTrack, protection(next.P, next.cal, next.msg, next.ev)).X;
    if (oldX !== newX) {
      superseded.push("r26");
      delete next.r26;
    } else if (next.r26.drop && !next.P?.includes(next.r26.drop)) {
      next.r26.drop = null;
    }
  } else if (editedNode === "r32" && previousAnswers.r32?.action !== next.r32?.action) {
    if (next.r32 && typeof next.r32 === "object") next.r32.sub = null;
  }

  return { answers: next, superseded };
}

export function lensReminder(lens, confirmedRecommendation, ledger) {
  const value = ledger?.lensReminders?.[lens]?.[confirmedRecommendation];
  if (!value) throw new RangeError(`Missing lens reminder for ${lens}/${confirmedRecommendation}`);
  return value;
}

export function newCheckpoints(definition) {
  return Object.fromEntries([...definition.round1, ...definition.round2].map((id) =>
    [id, { passed: false, variant: 0, selection: "", history: [] }]));
}

export function submitEvidence(checkpoint, concept, answer) {
  if (checkpoint.passed) throw new RangeError("Concept already passed");
  const variant = concept.variants[checkpoint.variant];
  if (!variant?.options.some((option) => option.id === answer)) throw new RangeError("Invalid evidence answer");
  const correct = answer === variant.answer;
  return {
    passed: correct,
    variant: correct ? checkpoint.variant : (checkpoint.variant + 1) % concept.variants.length,
    selection: "",
    history: [...checkpoint.history, { variant: checkpoint.variant, answer, correct }],
  };
}

export function validCheckpoints(checkpoints, definition) {
  const ids = [...definition.round1, ...definition.round2];
  if (!checkpoints || Object.keys(checkpoints).length !== ids.length) return false;
  return ids.every((id) => {
    const saved = checkpoints[id];
    const concept = definition.concepts[id];
    if (!saved || !concept || !Array.isArray(saved.history) || typeof saved.selection !== "string") return false;
    let replay = { passed: false, variant: 0, selection: "", history: [] };
    try {
      for (const attempt of saved.history) {
        if (attempt.variant !== replay.variant) return false;
        replay = submitEvidence(replay, concept, attempt.answer);
        if (attempt.correct !== replay.passed) return false;
      }
    } catch {
      return false;
    }
    const validSelection = saved.selection === "" || (!saved.passed &&
      concept.variants[replay.variant].options.some((option) => option.id === saved.selection));
    return validSelection && saved.passed === replay.passed && saved.variant === replay.variant;
  });
}

export function checkpointPassed(checkpoints, conceptIds) {
  return conceptIds.every((id) => checkpoints?.[id]?.passed === true);
}

export function checkpointTransition(state, round, definition) {
  const ids = round === 1 ? definition.round1 : definition.round2;
  if (!checkpointPassed(state.checkpoints, ids)) throw new RangeError("Both evidence concepts must be passed");
  const next = structuredClone(state);
  const saved = next.checkpointReturn;
  if (saved && round === 1 && saved.needsRound2) {
    next.screen = "Q2";
  } else if (saved) {
    next.screen = saved.screen;
    next.draft = saved.draft;
    delete next.checkpointReturn;
  } else {
    next.screen = round === 1 ? "S5" : "S13";
  }
  return next;
}

export function authorizationStatus(authorization, currentPlan) {
  const action = authorization?.action;
  const sub = authorization?.sub;
  const invalid = (reason) => ({ valid: false, reason });
  if (action === "RETAIN") return { valid: sub == null, reason: sub == null ? "" : "invalid" };
  if (action === "REFINE-CAL") {
    if (!["KEEP", "ALIGN", "OVERLAP"].includes(sub)) return invalid("missing");
    return sub === currentPlan.cal ? invalid("same") : { valid: true, reason: "" };
  }
  if (action === "REFINE-MSG") {
    if (!["PREM", "DEAL", "MIX"].includes(sub)) return invalid("missing");
    return sub === currentPlan.msg ? invalid("same") : { valid: true, reason: "" };
  }
  if (action === "REFINE-PRI") {
    if (!Array.isArray(sub) || sub.length !== 2 || new Set(sub).size !== 2
      || sub.some((item) => !["A", "B", "C", "D"].includes(item))) return invalid("missing");
    return sub.every((item) => currentPlan.P.includes(item))
      ? invalid("same")
      : { valid: true, reason: "" };
  }
  if (action?.startsWith("REVISE-")) {
    const target = action.slice("REVISE-".length);
    if (!["O1", "O2", "O3"].includes(target) || target === currentPlan.rec) return invalid("invalid");
    return authorization.confirmed === true ? { valid: true, reason: "" } : invalid("confirmation");
  }
  return invalid("invalid");
}

export function migrateLegacyState(value, definition, screens) {
  const next = structuredClone(value);
  if (next.locks.r3 && !next.completion.receipt) next.completion.receipt = buildReceipt(next);
  next.checkpoints = newCheckpoints(definition);
  const position = screens.indexOf(next.screen);
  const needsRound1 = position > screens.indexOf("S1");
  const needsRound2 = position >= screens.indexOf("S13");
  if (needsRound1) {
    next.checkpointReturn = { screen: next.screen, draft: next.draft, needsRound2, migrated: true };
    next.draft = null;
    next.screen = "Q1";
  }
  return next;
}

export function completionStatus(answers, locks) {
  const required = [
    ["lens", "R1.1"],
    ["initialRec", "R1.2"],
    ["r13", "R1.3"],
    ["r14", "R1.4"],
    ["r15", "R1.5"],
    ["r21", "R2.1"],
    ["P", "R2.2"],
    ["cal", "R2.3"],
    ["msg", "R2.4"],
    ["ev", "R2.5"],
    ["r26", "R2.6"],
    ["r31", "R3.1"],
    ["r32", "R3.2"],
  ];
  const missing = required
    .filter(([key]) => answers[key] === undefined || answers[key] === null)
    .map(([, node]) => node);
  if (answers.r15 !== "KEEP" && !answers.r15b) missing.push("R1.5b");
  if (
    answers.r32?.action?.startsWith("REFINE-") &&
    !answers.r32.sub
  ) {
    missing.push("R3.2 sub-choice");
  }
  if (
    answers.r32?.action?.startsWith("REVISE-") &&
    !answers.r32.confirmed
  ) {
    missing.push("R3.2 revision confirmation");
  }
  if (!answers.defense?.fact) missing.push("R3.3 case fact or calculation");
  if (!answers.defense?.dev) missing.push("R3.3 path development");
  const words = (answers.defense?.text ?? "").trim().match(/\S+/g)?.length ?? 0;
  if (!words) missing.push("R3.3 written defense");
  if (words > 150) missing.push("R3.3 word limit");
  if (!locks?.r1) missing.push("Round 1 lock");
  if (!locks?.r2) missing.push("Round 2 lock");
  if (!locks?.r3) missing.push("final submission");
  return { complete: missing.length === 0, missing };
}

export function verificationProvider() {
  return "[VERIFICATION VALUE: mechanism TBD]";
}

export function buildReceipt(state, provider = verificationProvider) {
  const total = state.answers?.r15 && state.answers.r15 !== "KEEP" ? 15 : 14;
  const timestamp = state.completion?.completedAt;
  if (!timestamp) throw new TypeError("A completion timestamp is required");
  return [
    "PLNJ SIMULATION COMPLETION RECEIPT",
    "STATUS: COMPLETE",
    `VERSION: ${state.appVersion ?? "1.0.0"}`,
    "ROUNDS COMPLETED: 3 of 3",
    `DECISIONS RECORDED: ${total} of ${total}`,
    "DEFENSE SUBMITTED: YES",
    `COMPLETED AT: ${timestamp}`,
    provider(),
  ].join("\n");
}
