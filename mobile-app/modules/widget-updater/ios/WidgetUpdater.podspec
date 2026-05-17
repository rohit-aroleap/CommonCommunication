require 'json'

# Local Expo module podspec consumed by CocoaPods during EAS prebuild.
# Mirrors the Android build.gradle: declare the module, depend on
# ExpoModulesCore, point at the Swift sources, that's it.
#
# The minimum iOS version (15.1) matches what Expo SDK 55 ships with;
# the widget itself targets iOS 17 via expo-target.config.js (deployment
# target). They differ on purpose — WidgetKit lets us use newer SwiftUI
# features without bumping the host app's minimum.

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'WidgetUpdater'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = 'Aroleap'
  s.license        = 'MIT'
  s.homepage       = 'https://github.com/rohit-aroleap/CommonCommunication'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift / Objective C compatibility — pulled straight from Expo's
  # template podspec so we share the bridging-header machinery.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
