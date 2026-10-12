import { Redirect } from "expo-router";
import { useDevice } from "../src/screens/device";
import { nextRoute } from "../src/screens/setup";

export default function Index() {
  const d = useDevice();
  if (!d) return null;
  return <Redirect href={nextRoute({ ...d, paired: d.deviceConfig !== null })} />;
}
