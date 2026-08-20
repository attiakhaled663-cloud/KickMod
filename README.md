# Kick Mod — Static / GitHub Pages

نسخة Static تعمل من GitHub Pages بدون Node.js أو قاعدة بيانات أو Backend.

## Redirect URI
استخدم هذا الرابط حرفيًا في Kick Developer App:

`https://attiakhaled663-cloud.github.io/KickMod/`

يجب أن يطابق `redirectUri` في `public/app.js` حرفيًا.

## بيانات Kick
تم ضبط Client ID وClient Secret داخل `public/app.js` بناءً على القيم التي زود بها صاحب المشروع.

**تنبيه:** لأن هذا المشروع Static، أي قيمة داخل JavaScript يمكن لأي شخص رؤيتها. لا تستخدم هذا الأسلوب لسر إنتاجي حساس.

## الوظائف
- OAuth 2.1 + PKCE
- إضافة عدة حسابات Kick
- تحديث Refresh Token
- فحص حالة التوكن عبر introspection
- إضافة/حذف القنوات
- جلب بيانات القنوات من Kick API الرسمي
- فحص البث كل 45 ثانية باستخدام `/public/v2/livestreams`
- إرسال الرسائل عبر `/public/v1/chat`
- رسائل عشوائية وفواصل زمنية
- تشغيل/إيقاف الحسابات المحددة
- نسخ واستعادة الإعدادات محليًا بكود مشفر AES-GCM
- تخزين البيانات في localStorage

## ملاحظة مهمة
صلاحيات التطبيق المستخدمة هي `user:read channel:read chat:write`. لا توجد محاولة لاستخدام endpoints غير موثقة.
