package com.termux.zerocore.zero.engine;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.view.View;

import com.example.xh_lib.utils.LogUtils;
import com.example.xh_lib.utils.UUtils;

import java.lang.reflect.Method;
import java.util.ArrayList;

/**
 * Reflection bridge to the optional {@code com.xinhao.zerocoremanage} engine app.
 *
 * <p>Paseo ships without that companion package, so every entry point here has to treat
 * "engine not installed" as a normal state. Before the availability guard existed each
 * call dereferenced a null {@link #ZERO_ENGINE_CLASS}, and the resulting
 * NullPointerException was swallowed by the local catch block after printing a full stack
 * trace, which flooded logcat during startup.
 */
public class ZeroCoreManage {
    public static String TAG = "ZeroCoreManage";
    public static String ZERO_ENGINE_PACKAGE = "com.xinhao.zerocoremanage";
    public static String ZERO_ENGINE_PACKAGE_CLASS = "com.xinhao.zerocoremanage.zeroeg.ZeroEngineManage";
    public static final int INSTALLING = 10002;
    public static final int INSTALL_COMPLETE = 10003;
    public static Context mContext;
    public static Class<?> ZERO_ENGINE_CLASS;

    /** Set once the engine package is known to be absent, so we log about it only once. */
    private static boolean sEngineUnavailableLogged;

    public static void initEngineManage() {
        try {
            mContext = UUtils.getContext().createPackageContext(ZERO_ENGINE_PACKAGE,
                    Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY);
            ZERO_ENGINE_CLASS = Class.forName(ZERO_ENGINE_PACKAGE_CLASS, true, mContext.getClassLoader());
            ZeroCoreManage.setContext();
            ZeroCoreManage.setEngineContext();
        } catch (PackageManager.NameNotFoundException | ClassNotFoundException notInstalled) {
            // Expected on builds that do not ship the companion engine app.
            mContext = null;
            ZERO_ENGINE_CLASS = null;
            logEngineUnavailableOnce();
        } catch (Exception e) {
            mContext = null;
            ZERO_ENGINE_CLASS = null;
            LogUtils.e(TAG, "initEngineManage error:" + e);
        }
    }

    /** @return true when the companion engine app is present and its entry class loaded. */
    public static boolean isEngineAvailable() {
        return ZERO_ENGINE_CLASS != null;
    }

    /**
     * @return a fresh engine instance, or null when the engine app is not installed. Callers
     *         must null-check instead of assuming an instance exists.
     */
    private static Object newEngine(String caller) {
        if (ZERO_ENGINE_CLASS == null) {
            logEngineUnavailableOnce();
            return null;
        }
        try {
            return ZERO_ENGINE_CLASS.newInstance();
        } catch (Exception e) {
            LogUtils.e(TAG, caller + " could not instantiate the engine:" + e);
            return null;
        }
    }

    private static void logEngineUnavailableOnce() {
        if (sEngineUnavailableLogged) return;
        sEngineUnavailableLogged = true;
        LogUtils.d(TAG, "Engine package " + ZERO_ENGINE_PACKAGE
                + " is not installed; ZeroCore engine features stay disabled");
    }

    public static ArrayList<String> getEnvironment() {
        Object object = newEngine("getEnvironment");
        if (object == null) return null;
        try {
            Method mMethod = object.getClass().getMethod("getEnvironment");
            return (ArrayList<String>) mMethod.invoke(object);
        } catch (Exception e) {
            LogUtils.e(TAG, "getEnvironment error:" + e);
        }
        return null;
    }

    public static ArrayList<String> getProcessArgs() {
        Object object = newEngine("getProcessArgs");
        if (object == null) return null;
        try {
            Method mMethod = object.getClass().getMethod("getProcessArgs");
            return (ArrayList<String>) mMethod.invoke(object);
        } catch (Exception e) {
            LogUtils.e(TAG, "getProcessArgs error:" + e);
        }
        return null;
    }

    public static String getDataDirectory() {
        Object object = newEngine("getDataDirectory");
        if (object == null) return null;
        try {
            Method mMethod = object.getClass().getMethod("getDataDirectory");
            return (String) mMethod.invoke(object);
        } catch (Exception e) {
            LogUtils.e(TAG, "getDataDirectory error:" + e);
        }
        return null;
    }

    public static void setContext() {
        Object object = newEngine("setContext");
        if (object == null) return;
        try {
            Method mMethod = object.getClass().getMethod("setContext", Context.class);
            mMethod.invoke(object, UUtils.getContext());
        } catch (Exception e) {
            LogUtils.e(TAG, "setContext error:" + e);
        }
    }

    public static void setEngineContext() {
        Object object = newEngine("setEngineContext");
        if (object == null) return;
        try {
            Method mMethod = object.getClass().getMethod("setEngineContext", Context.class);
            mMethod.invoke(object, mContext);
        } catch (Exception e) {
            LogUtils.e(TAG, "setEngineContext error:" + e);
        }
    }

    public static void install(Handler mHandler) {
        Object object = newEngine("install");
        if (object == null) return;
        try {
            Method mMethod = object.getClass().getMethod("install", Handler.class);
            mMethod.invoke(object, mHandler);
        } catch (Exception e) {
            LogUtils.e(TAG, "install error:" + e);
        }
    }

    public static String getVersionName() {
        Object object = newEngine("getVersionName");
        if (object == null) return "";
        try {
            Method mMethod = object.getClass().getMethod("getVersionName", Context.class);
            return (String) mMethod.invoke(object, mContext);
        } catch (Exception e) {
            LogUtils.e(TAG, "getVersionName error:" + e);
        }
        return "";
    }

    public static void setRunHandler(Handler mHandler) {
        Object object = newEngine("setRunHandler");
        if (object == null) return;
        try {
            Method mMethod = object.getClass().getMethod("setRunHandler", Handler.class);
            mMethod.invoke(object, mHandler);
        } catch (Exception e) {
            LogUtils.e(TAG, "setRunHandler error:" + e);
        }
    }

    public static void setKeyHandler(Handler mHandler) {
        Object object = newEngine("setKeyHandler");
        if (object == null) return;
        try {
            Method mMethod = object.getClass().getMethod("setKeyHandler", Handler.class);
            mMethod.invoke(object, mHandler);
        } catch (Exception e) {
            LogUtils.e(TAG, "setKeyHandler error:" + e);
        }
    }

    public static void installFileBrowser(Handler mInstallHandler) {
        Object object = newEngine("installFileBrowser");
        if (object == null) return;
        try {
            Method mMethod = object.getClass().getMethod("installFileBrowser", Context.class, Context.class, Handler.class);
            mMethod.invoke(object, UUtils.getContext(), mContext, mInstallHandler);
        } catch (Exception e) {
            LogUtils.e(TAG, "installFileBrowser error:" + e);
        }
    }

    public static void initKeyView() {
        Object object = newEngine("initKeyView");
        if (object == null) return;
        try {
            Method mMethod = object.getClass().getMethod("initKeyView");
            mMethod.invoke(object);
        } catch (Exception e) {
            LogUtils.e(TAG, "initKeyView error:" + e);
        }
    }

    public static View getKeyView() {
        Object object = newEngine("getKeyView");
        if (object == null) return null;
        try {
            Method mMethod = object.getClass().getMethod("getKeyView");
            return (View) mMethod.invoke(object);
        } catch (Exception e) {
            LogUtils.e(TAG, "getKeyView error:" + e);
        }
        return null;
    }

    private static Object setMethod(Method[] methods, String method,  Object o, Object... var2) {
        if (methods == null || methods.length == 0) {
            LogUtils.e(TAG, "setMethod methods is empty");
            return null;
        }

        for (int i = 0; i < methods.length; i++) {
            LogUtils.d(TAG, "setMethod methods:" + methods[i].getName());
            if(methods[i].getName().equals(method)) {
                methods[i].setAccessible(true);
                try {
                   return methods[i].invoke(o, var2);
                } catch (Exception e) {
                    e.printStackTrace();
                    LogUtils.e(TAG, "setMethod error:" + e);
                }
            }
        }

        return null;
    }

}
