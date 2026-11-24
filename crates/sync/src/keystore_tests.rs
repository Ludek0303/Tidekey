use super::*;

/// Compile-time check: every slot is a device key, an epoch key or a log head, none is the recovery phrase.
fn only_device_epoch_and_head_slots(slot: Slot) -> bool {
    match slot {
        Slot::DeviceSign | Slot::DeviceBox => true,
        Slot::EpochKey { .. } | Slot::AclHead { .. } => true,
    }
}

#[test]
fn memory_store_round_trip_and_delete() {
    let mut store = MemoryKeyStore::default();
    let epoch = Slot::EpochKey {
        space: [1; 16],
        epoch: 2,
    };
    assert!(store.get(Slot::DeviceSign).unwrap().is_none());

    store.set(Slot::DeviceSign, &[1; 32]).unwrap();
    store.set(Slot::DeviceBox, &[2; 32]).unwrap();
    store.set(epoch, &[3; 32]).unwrap();
    assert_eq!(*store.get(Slot::DeviceSign).unwrap().unwrap(), vec![1; 32]);
    assert_eq!(*store.get(epoch).unwrap().unwrap(), vec![3; 32]);
    assert!(
        store
            .get(Slot::EpochKey {
                space: [1; 16],
                epoch: 3
            })
            .unwrap()
            .is_none()
    );

    store.delete(Slot::DeviceSign).unwrap();
    assert!(store.get(Slot::DeviceSign).unwrap().is_none());
    assert!(store.get(Slot::DeviceBox).unwrap().is_some());
    assert!(only_device_epoch_and_head_slots(epoch));
}
