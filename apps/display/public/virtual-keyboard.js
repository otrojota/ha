(() => {
  const textRows = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l", "ñ"],
    ["shift", "z", "x", "c", "v", "b", "n", "m", "backspace"],
    ["á", "é", "í", "ó", "ú", "ü", "/", "-", "_", "."],
    ["left", "space", "right", "done"]
  ];
  const numericRows = [
    ["7", "8", "9"], ["4", "5", "6"], ["1", "2", "3"],
    ["-", "0", ".", "backspace"], ["left", "right", "done"]
  ];
  const labels = { shift: "⇧", backspace: "⌫", left: "←", right: "→", space: "Espacio", done: "Listo" };

  class VirtualKeyboard {
    constructor() {
      this.input = null;
      this.shifted = false;
      this.root = document.createElement("aside");
      this.root.id = "virtual-keyboard";
      this.root.className = "virtual-keyboard";
      this.root.hidden = true;
      this.root.setAttribute("role", "dialog");
      this.root.setAttribute("aria-label", "Teclado en pantalla");
      this.root.innerHTML = `<div class="virtual-keyboard-header"><span id="virtual-keyboard-label">Teclado</span><button type="button" data-key="done" aria-label="Cerrar teclado">×</button></div><div class="virtual-keyboard-rows"></div>`;
      document.body.append(this.root);
      document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea").forEach((input) => {
        input.dataset.originalInputmode = input.getAttribute("inputmode") || "";
        input.setAttribute("inputmode", "none");
      });
      this.rows = this.root.querySelector(".virtual-keyboard-rows");
      this.label = this.root.querySelector("#virtual-keyboard-label");
      this.root.addEventListener("pointerdown", (event) => event.preventDefault());
      this.root.addEventListener("click", (event) => {
        const key = event.target.closest("[data-key]")?.dataset.key;
        if (key) this.press(key);
      });
      document.addEventListener("focusin", (event) => {
        if (event.target.matches("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea")) this.show(event.target);
      });
    }

    keyboardType(input) {
      return input.dataset.virtualKeyboard || (["number", "range"].includes(input.type) ? "numeric" : "text");
    }

    show(input) {
      if (input.disabled || input.readOnly) return;
      this.input = input;
      this.shifted = false;
      this.label.textContent = input.closest("label")?.childNodes[0]?.textContent?.trim() || input.getAttribute("aria-label") || "Teclado";
      this.render();
      this.root.hidden = false;
      document.body.classList.add("virtual-keyboard-open");
      setTimeout(() => input.scrollIntoView?.({ behavior: "smooth", block: "center" }), 80);
    }

    hide() {
      this.input = null;
      this.root.hidden = true;
      document.body.classList.remove("virtual-keyboard-open");
    }

    render() {
      const rows = this.keyboardType(this.input) === "numeric" ? numericRows : textRows;
      this.rows.replaceChildren(...rows.map((keys) => {
        const row = document.createElement("div");
        row.className = "virtual-keyboard-row";
        row.style.setProperty("--key-count", keys.length);
        row.append(...keys.map((key) => {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.key = key;
          button.className = `virtual-key${["space", "done", "backspace", "shift"].includes(key) ? ` key-${key}` : ""}${key === "shift" && this.shifted ? " active" : ""}`;
          const printable = key.length === 1 && this.shifted ? key.toLocaleUpperCase("es") : key;
          button.textContent = labels[key] || printable;
          button.setAttribute("aria-label", labels[key] || printable);
          return button;
        }));
        return row;
      }));
    }

    press(key) {
      if (!this.input) return;
      if (key === "done") return this.hide();
      if (key === "shift") {
        this.shifted = !this.shifted;
        this.render();
        return;
      }
      if (key === "left" || key === "right") return this.moveCursor(key === "left" ? -1 : 1);
      if (key === "backspace") return this.backspace();
      this.insert(key === "space" ? " " : (this.shifted ? key.toLocaleUpperCase("es") : key));
      if (this.shifted) {
        this.shifted = false;
        this.render();
      }
    }

    selection() {
      const end = Number.isInteger(this.input.selectionEnd) ? this.input.selectionEnd : this.input.value.length;
      const start = Number.isInteger(this.input.selectionStart) ? this.input.selectionStart : end;
      return { start, end };
    }

    setValue(value, cursor) {
      const maximum = Number(this.input.maxLength);
      if (maximum > 0 && value.length > maximum) return;
      this.input.value = value;
      try { this.input.setSelectionRange(cursor, cursor); } catch {}
      this.input.dispatchEvent(new Event("input", { bubbles: true }));
      this.input.focus({ preventScroll: true });
    }

    insert(value) {
      const { start, end } = this.selection();
      this.setValue(`${this.input.value.slice(0, start)}${value}${this.input.value.slice(end)}`, start + value.length);
    }

    backspace() {
      const { start, end } = this.selection();
      if (start !== end) return this.setValue(`${this.input.value.slice(0, start)}${this.input.value.slice(end)}`, start);
      if (start > 0) this.setValue(`${this.input.value.slice(0, start - 1)}${this.input.value.slice(end)}`, start - 1);
    }

    moveCursor(offset) {
      const { start, end } = this.selection();
      const cursor = Math.max(0, Math.min(this.input.value.length, offset < 0 ? start - 1 : end + 1));
      try { this.input.setSelectionRange(cursor, cursor); } catch {}
      this.input.focus({ preventScroll: true });
    }
  }

  window.virtualKeyboard = new VirtualKeyboard();
})();
