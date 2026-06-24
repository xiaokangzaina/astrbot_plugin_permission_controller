function pathJoin(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}

function getCollapsedObjectPaths(options = {}) {
  if (options.collapsedObjectPaths instanceof Set) {
    return options.collapsedObjectPaths;
  }
  if (Array.isArray(options.collapsedObjectPaths)) {
    return new Set(options.collapsedObjectPaths);
  }
  return new Set();
}

function getHiddenFields(options = {}) {
  if (options.hiddenFields instanceof Set) {
    return options.hiddenFields;
  }
  if (Array.isArray(options.hiddenFields)) {
    return new Set(options.hiddenFields);
  }
  return new Set();
}

function normalizeOptions(options = {}) {
  return {
    ...options,
    collapsedObjectPaths: getCollapsedObjectPaths(options),
    hiddenFields: getHiddenFields(options),
  };
}

function isDisabledPath(path, options = {}) {
  if (typeof options.isFieldDisabled !== "function") {
    return false;
  }
  return Boolean(options.isFieldDisabled(path));
}

function setByPath(target, path, value) {
  const parts = path.split(".");
  let cursor = target;

  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    if (!cursor[part] || typeof cursor[part] !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part];
  });
}

const FIELD_SECTIONS = [
  {
    title: "基础开关",
    desc: "控制当前群是否启用群管，以及是否跟随默认模板。",
    keys: ["follow_default", "group_admin_enabled"],
  },
  {
    title: "进群审核与欢迎",
    desc: "入群门槛、黑白词、欢迎语和新成员禁言。",
    keys: [
      "join_switch",
      "join_min_level",
      "join_max_time",
      "join_accept_words",
      "join_reject_words",
      "join_no_match_reject",
      "reject_word_block",
      "block_ids",
      "join_welcome",
      "join_ban_time",
    ],
  },
  {
    title: "退群处理",
    desc: "成员主动退群后的通知与拉黑策略。",
    keys: ["leave_notify", "leave_block"],
  },
  {
    title: "禁词与刷屏",
    desc: "内置/自定义禁词、触发禁言和刷屏处罚。",
    keys: ["builtin_ban", "custom_ban_words", "word_ban_time", "spamming_ban_time"],
  },
  {
    title: "链接管控",
    desc: "链接白名单、违规链接撤回、警告和踢出规则。",
    keys: [
      "link_whitelist",
      "filter_non_whitelist_links",
      "recall_admin_links",
      "link_recall_ban",
      "link_recall_ban_admin",
      "link_recall_ban_time",
      "link_recall_warn",
      "link_recall_warn_text",
      "link_recall_kick_count",
    ],
  },
  {
    title: "权限配置",
    desc: "命令权限、管理员权限等高级配置。",
    keys: ["perms"],
  },
];

function getSectionedEntries(schema, options = {}) {
  const entries = Object.entries(schema || {});
  const hiddenFields = options.hiddenFields || new Set();
  const entryMap = new Map(entries);
  const used = new Set();
  const sections = [];

  FIELD_SECTIONS.forEach((section) => {
    const sectionEntries = section.keys
      .filter((key) => entryMap.has(key) && !hiddenFields.has(key))
      .map((key) => [key, entryMap.get(key)]);
    if (sectionEntries.length) {
      sectionEntries.forEach(([key]) => used.add(key));
      sections.push({ ...section, entries: sectionEntries });
    }
  });

  const otherEntries = entries.filter(([key]) => !used.has(key) && !hiddenFields.has(key));
  if (otherEntries.length) {
    sections.push({
      title: "其他配置",
      desc: "未归入常用分类的扩展配置。",
      keys: otherEntries.map(([key]) => key),
      entries: otherEntries,
    });
  }

  return sections;
}

function appendHintNode(parent, hintText) {
  const hint = document.createElement("div");
  hint.className = "field-hint";
  const text = String(hintText || "");
  hint.textContent = text;

  const tokens = Array.from(new Set(text.match(/\{[a-zA-Z0-9_]+\}/g) || []));
  if (tokens.length) {
    const tokenRow = document.createElement("div");
    tokenRow.className = "placeholder-row";
    tokens.forEach((token) => {
      const badge = document.createElement("code");
      badge.className = "placeholder-token";
      badge.textContent = token;
      tokenRow.appendChild(badge);
    });
    hint.appendChild(tokenRow);
  }

  parent.appendChild(hint);
}

function buildField(path, key, schema, value, options = {}) {
  const type = schema.type || "string";
  const disabled = isDisabledPath(path, options);

  if (type === "object") {
    const wrapper = document.createElement("section");
    wrapper.className = "form-object";
    const isCollapsible = options.collapsedObjectPaths.has(path);
    if (disabled) {
      wrapper.classList.add("is-disabled");
    }
    let bodyHost = wrapper;

    if (isCollapsible) {
      wrapper.classList.add("is-collapsible");

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "form-object-toggle";
      toggle.disabled = disabled;

      const copy = document.createElement("span");
      copy.className = "form-object-toggle-copy section-head";

      const title = document.createElement("span");
      title.className = "section-title";
      title.textContent = schema.description || key;
      copy.appendChild(title);

      if (schema.hint) {
        appendHintNode(copy, schema.hint);
      }

      const action = document.createElement("span");
      action.className = "form-object-toggle-action";

      let collapsed = true;
      const syncCollapsedState = () => {
        wrapper.classList.toggle("is-collapsed", collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        action.textContent = collapsed ? "展开" : "收起";
      };

      toggle.appendChild(copy);
      toggle.appendChild(action);
      toggle.addEventListener("click", () => {
        collapsed = !collapsed;
        syncCollapsedState();
      });
      wrapper.appendChild(toggle);

      const body = document.createElement("div");
      body.className = "form-object-body";
      wrapper.appendChild(body);
      bodyHost = body;

      syncCollapsedState();
    } else {
      const header = document.createElement("div");
      header.className = "section-head";

      const title = document.createElement("div");
      title.className = "section-title";
      title.textContent = schema.description || key;
      header.appendChild(title);

      if (schema.hint) {
        appendHintNode(header, schema.hint);
      }

      wrapper.appendChild(header);
    }

    const grid = document.createElement("div");
    grid.className = "field-grid";
    if (options.singleColumn) {
      grid.classList.add("single-column");
    }
    Object.entries(schema.items || {}).forEach(([childKey, childSchema]) => {
      grid.appendChild(
        buildField(
          pathJoin(path, childKey),
          childKey,
          childSchema,
          value?.[childKey] ?? childSchema.default,
          options
        )
      );
    });
    bodyHost.appendChild(grid);
    return wrapper;
  }

  const field = document.createElement("label");
  field.className = "field";
  if (type === "bool") {
    field.classList.add("checkbox-field");
  }
  if (disabled) {
    field.classList.add("is-disabled");
  }

  const copy = document.createElement("div");
  copy.className = "field-copy";

  const label = document.createElement("div");
  label.className = "field-label";
  label.textContent = schema.description || key;
  copy.appendChild(label);

  if (schema.hint) {
    appendHintNode(copy, schema.hint);
  }

  field.appendChild(copy);

  const control = document.createElement("div");
  control.className = "field-control";

  let input;
  if (type === "bool") {
    const shell = document.createElement("span");
    shell.className = "switch";
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(value);
    const slider = document.createElement("span");
    slider.className = "slider";
    shell.appendChild(input);
    shell.appendChild(slider);
    control.appendChild(shell);
  } else if (schema.options?.length) {
    input = document.createElement("select");
    schema.options.forEach((option) => {
      const node = document.createElement("option");
      node.value = option;
      node.textContent = option;
      if (String(value ?? schema.default ?? "") === option) {
        node.selected = true;
      }
      input.appendChild(node);
    });
    control.appendChild(input);
  } else if (type === "int") {
    input = document.createElement("input");
    input.type = "number";
    input.value = String(value ?? schema.default ?? 0);
    if (schema.slider) {
      if (schema.slider.min !== undefined) input.min = schema.slider.min;
      if (schema.slider.max !== undefined) input.max = schema.slider.max;
      if (schema.slider.step !== undefined) input.step = schema.slider.step;
    }
    control.appendChild(input);
  } else if (type === "list") {
    input = document.createElement("textarea");
    input.value = Array.isArray(value) ? value.join("\n") : "";
    input.placeholder = "每行一个条目，也支持粘贴后分行整理";
    control.appendChild(input);
  } else {
    const multiline =
      type === "text" ||
      String(value || "").includes("\n") ||
      key.includes("welcome");
    input = document.createElement(multiline ? "textarea" : "input");
    if (!multiline) {
      input.type = "text";
    }
    input.value = String(value ?? schema.default ?? "");
    control.appendChild(input);
  }

  input.dataset.path = path;
  input.dataset.type = type;
  input.disabled = disabled;
  field.appendChild(control);
  return field;
}

export function renderSchemaFields(root, schema, values, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  root.innerHTML = "";

  const sections = getSectionedEntries(schema, normalizedOptions);
  sections.forEach((section) => {
    const sectionNode = document.createElement("section");
    sectionNode.className = "config-section";

    const header = document.createElement("div");
    header.className = "config-section-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "config-section-copy";

    const title = document.createElement("h3");
    title.textContent = section.title;
    titleWrap.appendChild(title);

    const desc = document.createElement("p");
    desc.textContent = section.desc;
    titleWrap.appendChild(desc);

    const count = document.createElement("span");
    count.className = "config-section-count";
    count.textContent = `${section.entries.length} 项`;

    header.appendChild(titleWrap);
    header.appendChild(count);
    sectionNode.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "field-grid";
    if (normalizedOptions.singleColumn) {
      grid.classList.add("single-column");
    }

    section.entries.forEach(([key, fieldSchema]) => {
      grid.appendChild(
        buildField(
          key,
          key,
          fieldSchema,
          values?.[key] ?? fieldSchema.default,
          normalizedOptions
        )
      );
    });

    sectionNode.appendChild(grid);
    root.appendChild(sectionNode);
  });
}

export function collectFormData(root) {
  const payload = {};
  root.querySelectorAll("[data-path]").forEach((node) => {
    const { path, type } = node.dataset;
    let value;

    if (type === "bool") {
      value = node.checked;
    } else if (type === "int") {
      value = Number(node.value || 0);
    } else if (type === "list") {
      value = node.value
        .split(/\n+/)
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      value = node.value;
    }

    setByPath(payload, path, value);
  });
  return payload;
}
