import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'firebase_options.dart';

// ─── Local Notifications Setup ─────────────────────────────────────────────
final FlutterLocalNotificationsPlugin _localNotifications =
    FlutterLocalNotificationsPlugin();

const AndroidNotificationChannel _channel = AndroidNotificationChannel(
  'farwaniya_high_importance',
  'إشعارات الفروانية',
  description: 'إشعارات طلبات الموظفين والضباط',
  importance: Importance.max,
);

// ─── Background message handler (must be top-level) ────────────────────────
@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await _showLocalNotification(message);
}

Future<void> _showLocalNotification(RemoteMessage message) async {
  final notification = message.notification;
  if (notification == null) return;

  await _localNotifications.show(
    notification.hashCode,
    notification.title ?? 'إشعار جديد',
    notification.body ?? '',
    NotificationDetails(
      iOS: const DarwinNotificationDetails(
        presentAlert: true,
        presentBadge: true,
        presentSound: true,
      ),
      android: AndroidNotificationDetails(
        _channel.id,
        _channel.name,
        channelDescription: _channel.description,
        importance: Importance.max,
        priority: Priority.high,
      ),
    ),
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);

  // Background FCM handler
  FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);

  // Foreground FCM handler - يظهر الإشعار وهو التطبيق مفتوح
  FirebaseMessaging.onMessage.listen((RemoteMessage message) {
    _showLocalNotification(message);
  });

  // iOS: اعرض الإشعارات حتى وهو التطبيق في الواجهة
  await FirebaseMessaging.instance.setForegroundNotificationPresentationOptions(
    alert: true,
    badge: true,
    sound: true,
  );

  // Init local notifications
  await _localNotifications.initialize(
    const InitializationSettings(
      iOS: DarwinInitializationSettings(
        requestAlertPermission: true,
        requestBadgePermission: true,
        requestSoundPermission: true,
      ),
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ),
  );

  // Create Android channel
  await _localNotifications
      .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>()
      ?.createNotificationChannel(_channel);

  // Request iOS permission
  await FirebaseMessaging.instance.requestPermission(
    alert: true,
    badge: true,
    sound: true,
  );

  // الاشتراك في topic — يُنفَّذ في الخلفية حتى لا يؤخر شاشة Launch / فتح التطبيق
  // ignore: unawaited_futures
  Future(() async {
    try {
      if (Platform.isIOS) {
        String? apnsToken;
        // انتظر حتى 30 ثانية (30 محاولة × ثانية) — لكن بالخلفية الآن
        for (int i = 0; i < 30; i++) {
          apnsToken = await FirebaseMessaging.instance.getAPNSToken();
          if (apnsToken != null) break;
          await Future<void>.delayed(const Duration(seconds: 1));
        }
        if (apnsToken != null) {
          await FirebaseMessaging.instance.subscribeToTopic('morning_shift');
          // ignore: avoid_print
          print('✅ Subscribed to morning_shift topic');
        } else {
          FirebaseMessaging.instance.onTokenRefresh.listen((_) async {
            try {
              await FirebaseMessaging.instance.subscribeToTopic('morning_shift');
              // ignore: avoid_print
              print('✅ Subscribed to morning_shift (via onTokenRefresh)');
            } catch (e) {
              // ignore: avoid_print
              print('❌ onTokenRefresh subscription error: $e');
            }
          });
          // ignore: avoid_print
          print('⚠️ APNS token not ready - registered onTokenRefresh listener');
        }
      } else {
        await FirebaseMessaging.instance.subscribeToTopic('morning_shift');
      }
    } catch (e) {
      // ignore: avoid_print
      print('❌ FCM subscription error: $e');
    }
  });

  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: WebViewScreen(),
    );
  }
}

class WebViewScreen extends StatefulWidget {
  const WebViewScreen({super.key});

  @override
  State<WebViewScreen> createState() => _WebViewScreenState();
}

class _WebViewScreenState extends State<WebViewScreen> {
  InAppWebViewController? _controller;
  String? _pendingPrintData;
  String? _savedSession;

  @override
  void initState() {
    super.initState();
    _setupFCM();
  }

  void _setupFCM() {
    // Foreground messages → show local notification
    FirebaseMessaging.onMessage.listen((RemoteMessage message) {
      _showLocalNotification(message);
      // أيضاً أرسل للـ WebView
      _controller?.evaluateJavascript(
        source: "if(typeof playNotificationSound==='function') playNotificationSound();",
      );
    });

    // Notification tap when app in background
    FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
      _controller?.evaluateJavascript(
        source: "if(typeof showNotificationsPage==='function') showNotificationsPage();",
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        top: true,
        bottom: false,
        child: InAppWebView(
          initialFile: 'assets/web/index.html',
          initialSettings: InAppWebViewSettings(
            javaScriptEnabled: true,
            allowFileAccessFromFileURLs: true,
            allowUniversalAccessFromFileURLs: true,
            useShouldOverrideUrlLoading: false,
          ),
          onWebViewCreated: (controller) {
            _controller = controller;
            controller.addJavaScriptHandler(
              handlerName: 'playSystemSound',
              callback: (args) async {
                await SystemSound.play(SystemSoundType.alert);
                return null;
              },
            );
            controller.addJavaScriptHandler(
              handlerName: 'printCurrentPage',
              callback: (args) async {
                await Future.delayed(const Duration(milliseconds: 300));
                await _controller?.printCurrentPage();
                return null;
              },
            );
            controller.addJavaScriptHandler(
              handlerName: 'goBackToApp',
              callback: (args) async {
                await _controller?.loadFile(assetFilePath: 'assets/web/index.html');
                return null;
              },
            );
            controller.addJavaScriptHandler(
              handlerName: 'navigateToPrint',
              callback: (args) async {
                if (args.isNotEmpty) {
                  final relativePath = args[0] as String;
                  if (args.length > 1 && args[1] != null) {
                    _pendingPrintData = args[1] as String;
                  }
                  await _controller?.loadFile(
                    assetFilePath: 'assets/web/$relativePath',
                  );
                }
                return null;
              },
            );
            controller.addJavaScriptHandler(
              handlerName: 'saveSession',
              callback: (args) async {
                if (args.isNotEmpty && args[0] != null) {
                  _savedSession = args[0] as String;
                }
                return null;
              },
            );
            controller.addJavaScriptHandler(
              handlerName: 'getSession',
              callback: (args) async {
                final s = _savedSession;
                _savedSession = null;
                return s;
              },
            );
            // ─── FCM Token Handler ──────────────────────────────────────
            controller.addJavaScriptHandler(
              handlerName: 'getFCMToken',
              callback: (args) async {
                // يحاول حتى 15 مرة (كل ثانية) حتى APNS token يكون جاهزاً
                for (int i = 0; i < 15; i++) {
                  try {
                    final token = await FirebaseMessaging.instance.getToken();
                    if (token != null) return token;
                  } catch (_) {}
                  await Future<void>.delayed(const Duration(seconds: 1));
                }
                return null;
              },
            );
          },
          onLoadStop: (controller, url) async {
            // أرسل قيمة safe-area الحقيقية من Flutter للـ CSS
            final bottomPadding = MediaQuery.of(context).padding.bottom;
            await controller.evaluateJavascript(
              source: "document.documentElement.style.setProperty('--safe-bottom', '${bottomPadding}px');",
            );

            if (_pendingPrintData != null) {
              final data = _pendingPrintData!;
              _pendingPrintData = null;
              await Future.delayed(const Duration(milliseconds: 300));
              await controller.evaluateJavascript(
                source: '''
                  (function(){
                    try {
                      window.__printData = $data;
                      if (typeof window.fillData === "function") {
                        window.fillData(window.__printData);
                      }
                    } catch(e) { console.error("printData inject error:", e); }
                  })();
                ''',
              );
              // لا نطبع تلقائياً - المستخدم يضغط زر الطباعة في الصفحة (تجنب تكرار الطباعة)
            }
          },
        ),
      ),
    );
  }
}
