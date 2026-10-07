(() => {
  "use strict";

  /* ---------------- Config ---------------- */
  const API_BASE = "https://mansik-santulan-score-jpyt.onrender.com";
  const REQUEST_TIMEOUT_MS = 20000;
  // The API doesn't return the scale of the score. Adjust if your dataset uses a different range.
  const SCORE_MIN = 0;
  const SCORE_MAX = 10;
  const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 84; // r = 84 in the SVG

  /* ---------------- Field rules (mirror the Pydantic model) ---------------- */
  const FIELDS = {
    age:                     { type: "int",    min: 10, max: 100, label: "Age" },
    gender:                  { type: "select", label: "Gender" },
    country:                 { type: "text",   label: "Country" },
    academic_Level:          { type: "select", label: "Academic level" },
    most_Used_Platform:      { type: "select", label: "Most used platform" },
    purpose_Of_Use:          { type: "select", label: "Purpose of use" },
    avg_Daily_Usage_Hours:   { type: "float",  min: 0, max: 24, label: "Daily usage hours" },
    daily_Unlocks:           { type: "int",    min: 0, label: "Daily unlocks" },
    study_Hours:             { type: "float",  min: 0, max: 24, label: "Study hours" },
    physical_Activity_Hours: { type: "float",  min: 0, max: 2,  label: "Physical activity hours" },
    sleep_Hours_Per_Night:   { type: "float",  min: 0, max: 24, label: "Sleep hours" },
    stress_Level:            { type: "select", label: "Stress level" },
  };

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const form = $("predictForm");
  const submitBtn = $("submitBtn");
  const resetBtn = $("resetBtn");
  const againBtn = $("againBtn");
  const overlay = $("loadingOverlay");
  const alertBox = $("alertBox");
  const alertTitle = $("alertTitle");
  const alertList = $("alertList");
  const resultCard = $("resultCard");
  const gaugeFill = $("gaugeFill");
  const scoreValue = $("scoreValue");
  const scoreBadge = $("scoreBadge");
  const scoreText = $("scoreText");
  const apiStatus = $("apiStatus");
  const apiStatusText = $("apiStatusText");

  /* ---------------- Theme ---------------- */
  const root = document.documentElement;
  const savedTheme = safeStorage("get", "theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = savedTheme || (prefersDark ? "dark" : "light");

  $("themeToggle").addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    safeStorage("set", "theme", root.dataset.theme);
  });

  function safeStorage(action, key, value) {
    try {
      return action === "get" ? localStorage.getItem(key) : localStorage.setItem(key, value);
    } catch { return null; }
  }

  /* ---------------- Field helpers ---------------- */
  const fieldWrap = (name) => form.querySelector(`[data-field="${name}"]`);

  function setFieldError(name, message) {
    const wrap = fieldWrap(name);
    if (!wrap) return false;
    wrap.classList.add("invalid");
    wrap.querySelector(".error").textContent = message;
    return true;
  }

  function clearFieldError(name) {
    const wrap = fieldWrap(name);
    if (!wrap) return;
    wrap.classList.remove("invalid");
    wrap.querySelector(".error").textContent = "";
  }

  function clearAllErrors() {
    Object.keys(FIELDS).forEach(clearFieldError);
    hideAlert();
  }

  // Clear a field's error as soon as the user edits it.
  form.addEventListener("input", (e) => e.target.name && clearFieldError(e.target.name));
  form.addEventListener("change", (e) => e.target.name && clearFieldError(e.target.name));

  /* ---------------- Validation (client-side) ---------------- */
  function validate() {
    const payload = {};
    let firstInvalid = null;

    for (const [name, rule] of Object.entries(FIELDS)) {
      const el = form.elements[name];
      const raw = el.value.trim();
      let error = "";

      if (raw === "") {
        error = rule.type === "select" ? "Please choose an option." : "This field is required.";
      } else if (rule.type === "int" || rule.type === "float") {
        const num = Number(raw);
        if (!Number.isFinite(num)) error = "Enter a valid number.";
        else if (rule.type === "int" && !Number.isInteger(num)) error = "Enter a whole number.";
        else if (rule.min !== undefined && num < rule.min) error = `Must be at least ${rule.min}.`;
        else if (rule.max !== undefined && num > rule.max) error = `Must be at most ${rule.max}.`;
        else payload[name] = num;
      } else {
        payload[name] = raw;
      }

      if (error) {
        setFieldError(name, error);
        firstInvalid = firstInvalid || el;
      }
    }

    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: false });
      return null;
    }
    return payload;
  }

  /* ---------------- Alerts ---------------- */
  function showAlert(title, messages = []) {
    alertTitle.textContent = title;
    alertList.innerHTML = "";
    messages.forEach((m) => {
      const li = document.createElement("li");
      li.textContent = m;
      alertList.appendChild(li);
    });
    alertBox.hidden = false;
    alertBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function hideAlert() { alertBox.hidden = true; }
  $("alertClose").addEventListener("click", hideAlert);

  /* ---------------- Loading state ---------------- */
  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle("loading", isLoading);
    submitBtn.querySelector(".btn-label").textContent = isLoading ? "Predicting…" : "Predict score";
    overlay.hidden = !isLoading;
    overlay.setAttribute("aria-busy", String(isLoading));
    document.body.style.overflow = isLoading ? "hidden" : "";
  }

  /* ---------------- API ---------------- */
  class ApiError extends Error {
    constructor(message, { status = 0, details = [], fieldErrors = {} } = {}) {
      super(message);
      this.status = status;
      this.details = details;
      this.fieldErrors = fieldErrors;
    }
  }

  async function requestPrediction(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${API_BASE}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ApiError("The request timed out.", {
          details: ["The server took too long to respond. Please try again."],
        });
      }
      throw new ApiError("Can't reach the server.", {
        details: [
          `Make sure the API is running at ${API_BASE} (uvicorn main:app --reload).`,
          "Also check your network connection and CORS settings.",
        ],
      });
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try { body = await response.json(); } catch { /* non-JSON body */ }

    if (response.ok) {
      const score = body && body.predicted_mental_health_score;
      if (typeof score !== "number") {
        throw new ApiError("Unexpected response from the server.", {
          status: response.status,
          details: ["The response did not contain a predicted_mental_health_score."],
        });
      }
      return score;
    }

    // FastAPI validation error: { detail: [ { loc: ["body", "age"], msg, type }, ... ] }
    if (response.status === 422 && body && Array.isArray(body.detail)) {
      const fieldErrors = {};
      const details = body.detail.map((d) => {
        const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : null;
        const label = (field && FIELDS[field] && FIELDS[field].label) || field || "Input";
        if (field && FIELDS[field]) fieldErrors[field] = d.msg;
        return `${label}: ${d.msg}`;
      });
      throw new ApiError("Some inputs were rejected by the server.", { status: 422, details, fieldErrors });
    }

    if (response.status >= 500) {
      throw new ApiError("The server hit an error while predicting.", {
        status: response.status,
        details: [
          "Check the terminal running uvicorn for the traceback.",
          typeof (body && body.detail) === "string" ? body.detail : `HTTP ${response.status}`,
        ],
      });
    }

    throw new ApiError(`Request failed (HTTP ${response.status}).`, {
      status: response.status,
      details: [typeof (body && body.detail) === "string" ? body.detail : response.statusText || "Unknown error"],
    });
  }

  /* ---------------- Result card ---------------- */
  function interpret(score) {
    const pct = (score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN);
    if (pct >= 0.7) return { cls: "good", label: "Healthy range", text: "The model estimates a relatively positive mental health score. Current habits look supportive of wellbeing." };
    if (pct >= 0.45) return { cls: "warn", label: "Moderate range", text: "The model estimates a moderate score. Small changes such as more sleep, less screen time or more activity may help." };
    return { cls: "bad", label: "Needs attention", text: "The model estimates a lower score. Consider reviewing screen time, sleep and stress, and talk to someone you trust." };
  }

  function colorFor(cls) {
    return { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)" }[cls];
  }

  function showResult(score) {
    const info = interpret(score);
    const pct = Math.min(1, Math.max(0, (score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)));

    resultCard.hidden = false;
    scoreBadge.textContent = info.label;
    scoreBadge.className = `badge ${info.cls}`;
    scoreText.textContent = info.text;
    gaugeFill.style.stroke = colorFor(info.cls);

    // Reset then animate the ring and count up the number.
    gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE * (1 - pct);
    }));
    animateNumber(scoreValue, score, 1100);

    resultCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function animateNumber(el, target, duration) {
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * eased).toFixed(2);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------------- Events ---------------- */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAllErrors();
    resultCard.hidden = true;

    const payload = validate();
    if (!payload) {
      showAlert("Please fix the highlighted fields.");
      return;
    }

    setLoading(true);
    try {
      const score = await requestPrediction(payload);
      setLoading(false);
      showResult(score);
    } catch (err) {
      setLoading(false);
      const apiErr = err instanceof ApiError ? err : new ApiError("Something went wrong.", { details: [String(err.message || err)] });
      Object.entries(apiErr.fieldErrors).forEach(([name, msg]) => setFieldError(name, msg));
      showAlert(apiErr.message, apiErr.details);
      if (apiErr.status === 0) setApiStatus(false);
    }
  });

  resetBtn.addEventListener("click", () => {
    form.reset();
    clearAllErrors();
    resultCard.hidden = true;
  });

  againBtn.addEventListener("click", () => {
    resultCard.hidden = true;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    form.elements.age.focus({ preventScroll: true });
  });

  /* ---------------- API health indicator ---------------- */
  function setApiStatus(online) {
    apiStatus.classList.toggle("online", online);
    apiStatus.classList.toggle("offline", !online);
    apiStatusText.textContent = online ? "API online" : "API offline";
  }

  async function checkApi() {
    try {
      const res = await fetch(`${API_BASE}/`, { method: "GET" });
      setApiStatus(res.ok);
    } catch {
      setApiStatus(false);
    }
  }
  checkApi();
})();
