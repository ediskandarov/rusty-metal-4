// Keep local development and browser checks out of the production project.
if (location.hostname === "rustymetal4.com") {
  void import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init("phc_kPwi3xRAuc52ULjNfpy4n824y759JHJEMnMXNKryvXJ9", {
        api_host: "https://eu.i.posthog.com",
        defaults: "2026-05-30",
        capture_pageview: true,
        capture_pageleave: true,
        person_profiles: "never",
        autocapture: false,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        capture_performance: false,
        capture_exceptions: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_external_dependency_loading: true,
        advanced_disable_feature_flags: true,
      });
    })
    .catch(() => {
      // Analytics must not prevent the site from loading.
    });
}
