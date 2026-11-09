export async function prepareIsolation(): Promise<void> {
  if (crossOriginIsolated || !isSecureContext || !("serviceWorker" in navigator)) return;
  Object.assign(window, {
    coi: {
      async doReload() {
        // An update notification can arrive before the worker is ready to serve navigation.
        await navigator.serviceWorker.ready;
        window.location.reload();
      },
    },
  });
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("coi-serviceworker.js", document.baseURI).href;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Could not load browser support. Reload the page to retry."));
    document.head.append(script);
  });
}
