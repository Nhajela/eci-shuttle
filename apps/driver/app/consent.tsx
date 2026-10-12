import { router } from "expo-router";
import { Text } from "react-native";
import { acceptConsent } from "../src/screens/device";
import { Button, Screen, s } from "../src/screens/ui";

export default function Consent() {
  return (
    <Screen title="Before you start">
      <Text style={s.text}>This app shows riders where your shuttle is, so they know when it will reach them.</Text>
      <Text style={s.text}>
        • Your location is shared only during your shuttle hours. Outside them, the app is paused.
      </Text>
      <Text style={s.text}>• A notification always shows whether it is sharing or paused.</Text>
      <Text style={s.text}>• Location history is deleted after the event.</Text>
      <Text style={s.text}>
        • The shuttle team can pause or stop it at any time. You never need to open the app again.
      </Text>
      <Button
        label="I agree"
        onPress={async () => {
          await acceptConsent(Date.now());
          router.replace("/");
        }}
      />
    </Screen>
  );
}
