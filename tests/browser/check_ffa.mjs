/* Set the fixture before evaluating the shared membership scenario. */
process.env.TM4_TEST_FFA = "1";
await import("./check_live_membership.mjs");
