//! A job object that takes its children with it.
//!
//! Everything here starts processes that outlive their parent by default: a
//! killed agent leaves orphaned `pwsh.exe`, a killed launcher leaves an
//! orphaned shell and its conhost. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes
//! the operating system clean up even when nobody got the chance to.
//!
//! `JOB_OBJECT_LIMIT_BREAKAWAY_OK` goes with it, and is not a loosening worth
//! worrying about: a job belongs to the session of whoever created it, so a
//! process inside one **cannot start a process in another session** — which is
//! exactly what putting a terminal in the signed-in user's session is. Without
//! breakaway the attempt fails with a bare `ERROR_ACCESS_DENIED`. Only a child
//! that asks (`CREATE_BREAKAWAY_FROM_JOB`) leaves, and the shell launcher puts
//! what it starts straight into a job of its own, so nothing escapes cleanup.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

pub struct Job(HANDLE);

impl Job {
    pub fn create() -> Job {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !handle.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
            Job(handle)
        }
    }

    /// Put an already-running process into the job, by pid.
    pub fn adopt(&self, pid: u32) {
        if self.0.is_null() {
            return;
        }
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !proc.is_null() {
                AssignProcessToJobObject(self.0, proc);
                CloseHandle(proc);
            }
        }
    }

    /// Put a process we still hold a handle to into the job. Saves reopening
    /// it, and works even for a process that has already exited.
    pub fn adopt_handle(&self, process: HANDLE) {
        if self.0.is_null() || process.is_null() {
            return;
        }
        unsafe { AssignProcessToJobObject(self.0, process) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}
