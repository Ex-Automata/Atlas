"use strict";

(function () {
    const OPEN_CLASS = "action-bar--open";
    const actionBar = document.getElementById("actionBar");
    const handle = document.getElementById("actionBarHandle");
    const handleIcon = handle?.querySelector(".action-bar__handle-icon");
    const handleLabel = handle?.querySelector(".action-bar__handle-label");
    const itemsHost = document.getElementById("actionBarItems");

    /** @type {Map<string, {label: string, icon?: string, hint?: string, disabled?: boolean, onSelect: () => void, button: HTMLButtonElement}>} */
    const actions = new Map();

    if (!actionBar || !handle || !itemsHost) {
        console.warn("[Atlas] Quick Actions bar DOM is incomplete; aborting setup.");
        return;
    }

    console.log("[Atlas] Quick Actions bar script loaded.");

    function postMessage(payload) {
        try {
            window.vscode?.postMessage(payload);
        } catch (err) {
            console.warn("[Atlas] Failed to post message", payload, err);
        }
    }

    function getActionIds() {
        return Array.from(actions.keys());
    }

    function syncHandleIcon(open) {
        if (handleIcon) {
            handleIcon.textContent = open ? "☰" : "⋮";
        }
        if (handleLabel) {
            handleLabel.style.opacity = open ? "1" : "0.72";
        }
    }

    function setActionBarState(state) {
        actionBar.classList.toggle(OPEN_CLASS, state);
        actionBar.setAttribute("aria-expanded", String(state));
        handle.setAttribute("aria-expanded", String(state));
        actionBar.dataset.open = state ? "true" : "false";
        syncHandleIcon(state);

        const list = getActionIds();
        console.log(`[Atlas] Quick Actions ${state ? "expanded" : "collapsed"}.`, {
            open: state,
            actions: list,
        });

        postMessage({ type: "actionBarState", open: state, actions: list });
    }

    function toggleActionBar() {
        const next = !actionBar.classList.contains(OPEN_CLASS);
        console.log("[Atlas] Quick Actions toggle", { next });
        setActionBarState(next);
        postMessage({
            type: "actionBarToggle",
            wasOpen: !next,
            willOpen: next,
        });
    }

    function handleActionInvoke(event) {
        const target = event.target instanceof HTMLElement
            ? event.target.closest("[data-action-id]")
            : null;
        if (!target) {
            return;
        }

        const actionId = target.dataset.actionId;
        if (!actionId) {
            return;
        }

        const entry = actions.get(actionId);
        if (!entry || entry.disabled) {
            return;
        }

        console.log("[Atlas] Quick Actions invoke", actionId);
        try {
            entry.onSelect();
        } catch (err) {
            console.error(`[Atlas] Action '${actionId}' failed`, err);
        }
    }

    function renderActions() {
        const fragment = document.createDocumentFragment();
        for (const entry of actions.values()) {
            fragment.appendChild(entry.button);
        }
        itemsHost.replaceChildren(fragment);
    }

    function createActionButton(id, config) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "action-bar__button";
        button.dataset.actionId = id;
        button.title = config.hint || config.label;
        button.setAttribute("aria-label", config.label);
        button.dataset.disabled = config.disabled ? "true" : "false";
        if (config.disabled) {
            button.tabIndex = -1;
        }
        button.disabled = Boolean(config.disabled);

        const iconSpan = document.createElement("span");
        iconSpan.className = "action-bar__button-icon";
        iconSpan.textContent = config.icon || config.label?.slice(0, 2) || "?";

        const srLabel = document.createElement("span");
        srLabel.className = "sr-only";
        srLabel.textContent = config.label;

        button.append(iconSpan, srLabel);
        return button;
    }

    function registerAction(id, config) {
        if (!id) {
            throw new Error("[Atlas] Action id is required");
        }
        if (!config || typeof config.onSelect !== "function") {
            throw new Error(`[Atlas] Action '${id}' requires an onSelect handler`);
        }

        const existing = actions.get(id);
        const merged = {
            label: config.label || id,
            icon: config.icon,
            hint: config.hint || config.label,
            disabled: Boolean(config.disabled),
            onSelect: config.onSelect,
            button: existing?.button || createActionButton(id, config),
        };

        merged.button.title = merged.hint || merged.label;
        merged.button.setAttribute("aria-label", merged.label);
    merged.button.dataset.disabled = merged.disabled ? "true" : "false";
    merged.button.disabled = merged.disabled;
    merged.button.tabIndex = merged.disabled ? -1 : 0;

        const iconSpan = merged.button.querySelector(".action-bar__button-icon");
        if (iconSpan) {
            iconSpan.textContent = merged.icon || merged.label.slice(0, 2) || "?";
        }
        const srLabel = merged.button.querySelector(".sr-only");
        if (srLabel) {
            srLabel.textContent = merged.label;
        }

        actions.set(id, merged);
        renderActions();

        console.log("[Atlas] Registered quick action", { id, label: merged.label });
        postMessage({
            type: "actionBarRegistered",
            actionId: id,
            label: merged.label,
        });
    }

    function unregisterAction(id) {
        const entry = actions.get(id);
        if (!entry) {
            return;
        }
        entry.button.remove();
        actions.delete(id);
        renderActions();
        postMessage({ type: "actionBarUnregistered", actionId: id });
    }

    const api = {
        registerAction,
        unregisterAction,
        listActions: getActionIds,
        setOpen: setActionBarState,
        isOpen: () => actionBar.classList.contains(OPEN_CLASS),
    };

    window.AtlasActionBar = api;

    handle.addEventListener("click", toggleActionBar);
    itemsHost.addEventListener("click", handleActionInvoke);
    actionBar.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && actionBar.classList.contains(OPEN_CLASS)) {
            setActionBarState(false);
            event.stopPropagation();
        }
    });

    function registerDefaultActions() {
        window.AtlasActionBar.registerAction("resetViewport", {
            label: "Reset viewport",
            icon: "↺",
            hint: "Reset zoom and pan",
            onSelect: () => {
                window.dispatchEvent(new CustomEvent("atlas:resetViewport"));
                postMessage({ type: "resetViewport" });
            },
        });
    }

    function init() {
        console.log("[Atlas] Initialising Quick Actions bar");
        syncHandleIcon(false);
        registerDefaultActions();
        setActionBarState(false);
        postMessage({
            type: "actionBarReady",
            hasReset: actions.has("resetViewport"),
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();
