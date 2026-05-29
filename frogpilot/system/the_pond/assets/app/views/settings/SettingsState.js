import { useEffect, useRef, useState } from "preact/hooks";

import { http, messageFor } from "../../lib/http.js";
import { strings } from "../../lib/strings.js";
import { showToast } from "../../lib/toast.js";

export function useRouteSearch(routeQuery) {
  const [query, setQuery] = useState(() => routeQuery.q ?? "");

  useEffect(() => {
    setQuery(routeQuery.q ?? "");
  }, [routeQuery.q]);

  return [query, setQuery];
}

export function useSettingsData({ headingRef, retryRef }) {
  const [schema, setSchema] = useState(null);
  const [values, setValues] = useState({});
  const [defaults, setDefaults] = useState({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [statuses, setStatuses] = useState({});
  const focusHeadingAfterLoadRef = useRef(false);
  const focusRetryAfterFailureRef = useRef(false);

  const reload = ({ focusHeading = false } = {}) => {
    focusHeadingAfterLoadRef.current = focusHeading;
    setReloadKey((key) => key + 1);
  };

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    setLoading(true);
    setFailed(false);

    Promise.all([
      http.get("/api/settings/schema", { signal: controller.signal }),
      http.get("/api/params/all", { signal: controller.signal }),
      http.get("/api/params/defaults", { signal: controller.signal }),
    ])
      .then(([loadedSchema, loadedValues, loadedDefaults]) => {
        if (!mounted) {
          return;
        }

        setSchema(loadedSchema);
        setValues(loadedValues);
        setDefaults(loadedDefaults);
        setStatuses({});
        setLoading(false);
        focusRetryAfterFailureRef.current = false;
        if (focusHeadingAfterLoadRef.current) {
          focusHeadingAfterLoadRef.current = false;
          requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
        }
      })
      .catch((error) => {
        if (!mounted || error.name === "AbortError") {
          return;
        }

        if (focusHeadingAfterLoadRef.current) {
          focusHeadingAfterLoadRef.current = false;
          focusRetryAfterFailureRef.current = true;
        }
        setFailed(true);
        setLoading(false);
      });

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [headingRef, reloadKey]);

  useEffect(() => {
    if (failed && !loading && focusRetryAfterFailureRef.current) {
      focusRetryAfterFailureRef.current = false;
      requestAnimationFrame(() => retryRef.current?.focus({ preventScroll: true }));
    }
  }, [failed, loading, retryRef]);

  return { schema, values, setValues, defaults, loading, failed, reload, statuses, setStatuses };
}

export function useSettingsWriter({ values, setValues, setStatuses }) {
  const saveControllersRef = useRef(new Map());

  useEffect(() => {
    const controllers = saveControllersRef.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  return async function writeParam(toggle, value) {
    const param = toggle.param;
    let previous = values[param] ?? null;
    const stored = value === true ? "1" : value === false ? "0" : String(value);

    setValues((current) => {
      previous = current[param] ?? null;
      return { ...current, [param]: stored };
    });
    setStatuses((current) => ({ ...current, [param]: { kind: "saving", text: strings.settings.saving } }));

    const controllers = saveControllersRef.current;
    controllers.get(param)?.abort();
    const controller = new AbortController();
    controllers.set(param, controller);

    try {
      await http.put("/api/params", { key: param, value }, { signal: controller.signal });
      setStatuses((current) => ({
        ...current,
        [param]: {
          kind: toggle.reboot_required ? "pending-reboot" : "saved",
          text: toggle.reboot_required ? strings.settings.pendingReboot : strings.settings.saved,
        },
      }));
      showToast(strings.settings.saved);
      if (toggle.reboot_required) {
        showToast(strings.settings.rebootRequired);
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }

      setValues((current) => ({ ...current, [param]: previous }));
      setStatuses((current) => ({
        ...current,
        [param]: { kind: "failed", text: `${strings.settings.saveFailed} ${messageFor(error, "")}`.trim() },
      }));
      showToast(messageFor(error, strings.settings.saveFailed), "error");
    } finally {
      if (controllers.get(param) === controller) {
        controllers.delete(param);
      }
    }
  };
}
