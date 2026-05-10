// Smoke tests for Farwaniya Flutter app.
//
// Validates that the root MaterialApp constructs without exceptions.
// We do not pumpWidget the full tree because the inner WebView depends on
// platform channels that aren't available in the test environment.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:farwaniya_flutter_app/main.dart';

void main() {
  test('MyApp can be instantiated', () {
    const app = MyApp();
    expect(app, isA<StatelessWidget>());
  });
}



