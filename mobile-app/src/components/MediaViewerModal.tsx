// Fullscreen in-app image viewer. Replaces the v1.176 behavior where
// tapping an image bubble called Linking.openURL and bounced the user
// out to Safari / Chrome. Stays inside the app so back-gesture returns
// straight to the chat thread.
//
// v1.194: pinch-to-zoom works on iOS via ScrollView's native
// maximumZoomScale. Android falls back to a static fit-screen image —
// Android RN ScrollView doesn't honor maximumZoomScale, and proper
// pinch handling needs gesture-handler + reanimated which is heavier
// than this v1 warrants. Tap anywhere to dismiss.

import React from "react";
import {
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { mediaProxyUrl } from "@/lib/worker";

interface Props {
  visible: boolean;
  url: string | null;
  onClose: () => void;
}

export function MediaViewerModal({ visible, url, onClose }: Props) {
  const { width, height } = useWindowDimensions();

  if (!url) return null;
  const src = mediaProxyUrl(url);

  // On iOS the ScrollView gets maximumZoomScale and acts as a native
  // zoomable container. On Android we use a plain View since maximumZoomScale
  // is a no-op there — at least the image still fills the screen and tap
  // dismisses.
  const ImageBox = (
    <Image
      source={{ uri: src }}
      style={[styles.image, { width, height }]}
      resizeMode="contain"
    />
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        {/* Tap-to-dismiss layer covers the whole screen. The zoom
            container sits ON TOP so taps inside the image are eaten by
            the gesture handler; double-tap-to-zoom on iOS still works. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {Platform.OS === "ios" ? (
          <ScrollView
            style={styles.zoomScroll}
            contentContainerStyle={styles.zoomContent}
            maximumZoomScale={4}
            minimumZoomScale={1}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            bouncesZoom
            // Single tap on the image dismisses too — without this the
            // ScrollView eats taps and the user can't close from the
            // image area. Long-press / pinch / scroll still work for
            // their respective gestures.
            onScrollEndDrag={() => {}}
          >
            <Pressable onPress={onClose}>
              {ImageBox}
            </Pressable>
          </ScrollView>
        ) : (
          <Pressable onPress={onClose} style={styles.androidWrap}>
            {ImageBox}
          </Pressable>
        )}
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={onClose}
          hitSlop={12}
          accessibilityLabel="Close image"
        >
          <Text style={styles.closeTxt}>✕</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
    justifyContent: "center",
    alignItems: "center",
  },
  zoomScroll: { flex: 1, width: "100%" },
  zoomContent: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  androidWrap: { flex: 1, justifyContent: "center", alignItems: "center" },
  image: { backgroundColor: "transparent" },
  closeBtn: {
    position: "absolute",
    top: 56,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeTxt: { color: "white", fontSize: 18, fontWeight: "500" },
});
