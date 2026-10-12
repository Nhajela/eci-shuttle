import type { Mode } from "@eci-shuttle/shared/contracts";
import * as SecureStore from "expo-secure-store";
import * as Updates from "expo-updates";
import { createOta } from "./ota";

const KEY = "ota.attemptedUpdateId";

/** The app's OTA controller on the real expo-updates. Sync calls report() into its request and reconcile(targetUpdateId) after. */
export const createExpoOta = (getMode: () => Mode) =>
  createOta({
    updates: Updates,
    store: {
      get: () => SecureStore.getItemAsync(KEY),
      set: (id) => (id === null ? SecureStore.deleteItemAsync(KEY) : SecureStore.setItemAsync(KEY, id)),
    },
    getMode,
  });
