// Defines the location and push tasks before anything renders: Android runs this file headless (no UI) when a fix
// or a push arrives after the app was swiped away, and expo-router only loads app/ when it renders.
import "./src/runtime/native";
import "expo-router/entry";
