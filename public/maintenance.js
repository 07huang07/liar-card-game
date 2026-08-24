const maintenanceEls = {
  button: document.getElementById("maintenanceChannelBtn"),
  modal: document.getElementById("maintenanceModal"),
  close: document.getElementById("maintenanceClose"),
  password: document.getElementById("maintenancePassword"),
  date: document.getElementById("maintenanceDate"),
  content: document.getElementById("maintenanceContent"),
  message: document.getElementById("maintenanceMessage"),
  save: document.getElementById("maintenanceSave"),
  entries: document.getElementById("maintenanceEntries")
};

function escapeMaintenance(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderMaintenance(entries) {
  if (!maintenanceEls.entries) return;

  maintenanceEls.entries.innerHTML = (entries || []).map(entry => `
    <div class="maintenanceEntry">
      <time>${escapeMaintenance(entry.date)}</time>
      <span>${escapeMaintenance(entry.content)}</span>
    </div>
  `).join("");
}

async function loadMaintenance() {
  try {
    const res = await fetch("/api/maintenance", {
      headers: { "Accept": "application/json" }
    });

    const data = await res.json();
    if (data?.ok) renderMaintenance(data.entries);
  } catch {
    // API 暫時無法使用時保留 HTML 裡的預設內容。
  }
}

function todayText() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

maintenanceEls.button?.addEventListener("click", () => {
  maintenanceEls.modal?.classList.remove("hidden");
  maintenanceEls.message.textContent = "";
  if (!maintenanceEls.date.value) maintenanceEls.date.value = todayText();
  maintenanceEls.password.focus();
});

maintenanceEls.close?.addEventListener("click", () => {
  maintenanceEls.modal?.classList.add("hidden");
});

maintenanceEls.modal?.addEventListener("click", event => {
  if (event.target === maintenanceEls.modal) {
    maintenanceEls.modal.classList.add("hidden");
  }
});

maintenanceEls.save?.addEventListener("click", async () => {
  maintenanceEls.save.disabled = true;
  maintenanceEls.message.textContent = "正在儲存…";

  try {
    const res = await fetch("/api/maintenance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        password: maintenanceEls.password.value,
        date: maintenanceEls.date.value.trim(),
        content: maintenanceEls.content.value.trim()
      })
    });

    const data = await res.json();

    if (!res.ok || !data?.ok) {
      maintenanceEls.message.textContent = data?.message || "儲存失敗";
      return;
    }

    renderMaintenance(data.entries);
    maintenanceEls.message.textContent = "維修紀錄已新增";
    maintenanceEls.content.value = "";
    maintenanceEls.password.value = "";

    setTimeout(() => {
      maintenanceEls.modal?.classList.add("hidden");
      maintenanceEls.message.textContent = "";
    }, 700);
  } catch {
    maintenanceEls.message.textContent = "無法連線到伺服器";
  } finally {
    maintenanceEls.save.disabled = false;
  }
});

loadMaintenance();
