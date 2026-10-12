// Native wiring. Not unit-tested (imports native modules); the logic it feeds is tested in *.test.ts.
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { createDeviceStore } from "./deviceStore";
import type { KV } from "./kv";
import { createPingQueue } from "./pingQueue";

/** JSON files in the app's document directory. Writes go to a temp file then rename, so a crash never leaves half a file. */
const fileKV: KV = {
  async get(key) {
    const f = new File(Paths.document, `${key}.json`);
    return f.exists ? f.text() : null;
  },
  async set(key, value) {
    const tmp = new File(Paths.document, `${key}.json.tmp`);
    tmp.write(value);
    tmp.moveSync(new File(Paths.document, `${key}.json`), { overwrite: true });
  },
  async del(key) {
    const f = new File(Paths.document, `${key}.json`);
    if (f.exists) f.delete();
  },
};

const secureKV: KV = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  del: (k) => SecureStore.deleteItemAsync(k),
};

const builtInOrigin: string = Constants.expoConfig?.extra?.apiOrigin ?? "https://eci-shuttle.positivesumcompany.com";

export const deviceStore = createDeviceStore({ files: fileKV, secure: secureKV, builtInOrigin });
export const pingQueue = createPingQueue(fileKV);
