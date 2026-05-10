import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) return web;
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions are not supported for this platform.',
        );
    }
  }

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyAU9FEHJNYyHKZCkG5LSO7TH-LO2h66XPg',
    appId: '1:776911169491:ios:35a7ae8e475b67fc54b126',
    messagingSenderId: '776911169491',
    projectId: 'alfarwania',
    storageBucket: 'alfarwania.firebasestorage.app',
    iosBundleId: 'com.farwaniya.app',
  );

  // Placeholder for Android — update if needed
  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyAU9FEHJNYyHKZCkG5LSO7TH-LO2h66XPg',
    appId: '1:776911169491:android:0000000000000000000000',
    messagingSenderId: '776911169491',
    projectId: 'alfarwania',
    storageBucket: 'alfarwania.firebasestorage.app',
  );

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyAU9FEHJNYyHKZCkG5LSO7TH-LO2h66XPg',
    appId: '1:776911169491:web:0000000000000000000000',
    messagingSenderId: '776911169491',
    projectId: 'alfarwania',
    storageBucket: 'alfarwania.firebasestorage.app',
  );
}
