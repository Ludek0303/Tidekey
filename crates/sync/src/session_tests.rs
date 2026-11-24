use super::*;

use proptest::prelude::*;

use crate::acl::Role;
use crate::acl_state::AclHead;
use crate::cert::DeviceCert;
use crate::device::DeviceKeys;
use crate::keystore::Slot;
use crate::session::SyncStore;
use crate::space_access::secret32;
use crate::space_owner::revoke_device;
use crate::test_util::{NOW, Net, Permissive, account, endpoint, local_of, newest_by, team};

fn tempdirs(n: usize) -> Vec<tempfile::TempDir> {
    (0..n).map(|_| tempfile::tempdir().unwrap()).collect()
}

fn roots(dirs: &[tempfile::TempDir]) -> Vec<&std::path::Path> {
    dirs.iter().map(|d| d.path()).collect()
}

#[test]
fn editor_behind_in_the_log_gets_the_newer_log_first() {
    let dirs = tempdirs(3);
    let stores = team(&roots(&dirs), &[Role::Editor, Role::Editor]);
    let mut net = Net::new(stores);
    let owner_head = net.stores[0].acl_head().unwrap();
    assert!(net.stores[1].acl_head().unwrap().index < owner_head.index);

    let id = net.stores[0].opened.space.create_note("n.md").unwrap();
    net.stores[0]
        .opened
        .space
        .insert_text(&id, 0, "od właściciela")
        .unwrap();
    let l = net.connect(0, 1);
    // the owner answers the editor's Hello with its newer log before anything else
    let step = net.deliver(l, 0).unwrap();
    assert!(matches!(step.send.first(), Some(Frame::Acl { .. })));

    net.settle();
    assert!(net.failures.is_empty(), "{:?}", net.failures);
    assert_eq!(net.stores[1].acl_head(), Some(owner_head));
    assert_eq!(
        net.stores[1].opened.space.text(&id).unwrap(),
        "od właściciela"
    );
}

#[test]
fn reader_live_message_is_refused_by_the_owner() {
    let dirs = tempdirs(2);
    let mut net = Net::new(team(&roots(&dirs), &[Role::Reader]));
    let id = net.stores[0].opened.space.create_note("n.md").unwrap();
    net.stores[0]
        .opened
        .space
        .insert_text(&id, 0, "tylko czytaj")
        .unwrap();
    let l = net.connect(0, 1);
    net.settle();
    assert_eq!(net.texts(&id), vec!["tylko czytaj", "tylko czytaj"]);

    // the reader device ignores the rules and writes with the epoch-0 key
    let space = net.stores[0].opened.acl.space;
    let epoch0 = secret32(
        &net.stores[0]
            .ks
            .get(Slot::EpochKey { space, epoch: 0 })
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    net.stores[1]
        .opened
        .space
        .set_access(Box::new(Permissive(epoch0)));
    net.stores[1]
        .opened
        .space
        .insert_text(&id, 0, "czytelnik ")
        .unwrap();
    let reader = net.stores[1].opened.cert.device;
    let msg = newest_by(&net.stores[1].opened.space, reader);

    let step = net.feed(l, 0, Frame::Live(msg));
    assert!(step.new.is_empty());
    assert_eq!(net.links[l].sess[0].rejected(), 1);
    assert_eq!(net.texts(&id)[0], "tylko czytaj");
}

#[test]
fn revoked_device_gets_only_a_reject_at_hello() {
    let dirs = tempdirs(2);
    let mut net = Net::new(team(&roots(&dirs), &[Role::Editor]));
    let editor = net.stores[1].opened.cert.device;
    let owner_store = &mut net.stores[0];
    revoke_device(&mut owner_store.opened, &mut *owner_store.ks, editor).unwrap();

    let (mut owner, _) = Session::new(
        local_of(&net.stores[0], endpoint(0)),
        endpoint(1),
        &net.stores[0],
    );
    let (_, hello_e) = Session::new(
        local_of(&net.stores[1], endpoint(1)),
        endpoint(0),
        &net.stores[1],
    );
    // the owner's log is the longer one: it checks the device before it sends anything but a Reject
    let step = owner.on_frame(hello_e, &mut net.stores[0]).unwrap();
    assert!(step.close.is_some());
    assert!(matches!(step.send.as_slice(), [Frame::Reject(_)]));
}

#[test]
fn revoked_device_gets_no_live_message_and_the_connection_closes() {
    let dirs = tempdirs(2);
    let mut net = Net::new(team(&roots(&dirs), &[Role::Editor]));
    let l = net.connect(0, 1);
    net.settle();
    assert!(net.failures.is_empty(), "{:?}", net.failures);

    let editor = net.stores[1].opened.cert.device;
    let owner_store = &mut net.stores[0];
    revoke_device(&mut owner_store.opened, &mut *owner_store.ks, editor).unwrap();

    // the owner's session still knows the editor, but the store no longer lets it take part
    let owner_end = &net.links[l].sess[0];
    assert!(owner_end.ready());
    assert!(!owner_end.allowed(&net.stores[0]));
    assert!(owner_end.live(b"x", &net.stores[0]).is_none());
    // a message the editor sends after the revoke closes the connection instead of being stored
    net.feed(l, 0, Frame::Live(b"x".to_vec()));
    assert!(!net.open_between(0, 1));
    assert_eq!(
        net.failures.last().map(String::as_str),
        Some("brak dostępu do przestrzeni")
    );
}

#[test]
fn stranger_with_no_log_gets_only_a_reject() {
    let dirs = tempdirs(2);
    let mut net = Net::new(team(&roots(&dirs), &[Role::Editor]));
    // a device of another account, presenting this space's id
    let (_, stranger) = account();
    let keys = DeviceKeys::generate().unwrap();
    let cert = DeviceCert::issue(&stranger, &keys, NOW);
    let local = Local::Device {
        keys,
        cert,
        endpoint: [77; 32],
        expected_node: None,
        token: None,
    };
    // the stranger claims no log at all, so the owner's log is longer and the owner must judge it first
    let (_, hello) = Session::new(local, endpoint(0), &net.stores[1]);
    let hello = without_head(hello);
    let (mut owner, _) = Session::new(
        local_of(&net.stores[0], endpoint(0)),
        [77; 32],
        &net.stores[0],
    );
    let step = owner.on_frame(hello, &mut net.stores[0]).unwrap();
    assert!(step.close.is_some());
    assert!(matches!(step.send.as_slice(), [Frame::Reject(_)]));
    assert!(!owner.ready());
}

/// The same Hello with no log head, as a peer with no log would send.
fn without_head(hello: Frame) -> Frame {
    let Frame::Hello {
        protocol,
        space,
        proof,
        token,
        ..
    } = hello
    else {
        panic!("not a Hello");
    };
    Frame::Hello {
        protocol,
        space,
        proof,
        acl_head: None,
        token,
    }
}

/// The Hello a device sends, from its session's point of view.
fn hello_of(net: &Net, device: usize, remote: usize) -> Frame {
    Session::new(
        local_of(&net.stores[device], endpoint(device)),
        endpoint(remote),
        &net.stores[device],
    )
    .1
}

#[test]
fn hello_is_refused_for_wrong_bind_protocol_or_fork() {
    let dirs = tempdirs(2);
    let mut net = Net::new(team(&roots(&dirs), &[Role::Editor]));
    let owner_head = net.stores[0].acl_head().unwrap();

    let mut wrong_bind = Session::new(
        local_of(&net.stores[0], endpoint(0)),
        endpoint(9),
        &net.stores[0],
    )
    .0;
    let close = wrong_bind
        .on_frame(hello_of(&net, 1, 0), &mut net.stores[0])
        .unwrap()
        .close;
    assert!(close.unwrap().contains("podpis"));

    let mut old = Session::new(
        local_of(&net.stores[0], endpoint(0)),
        endpoint(1),
        &net.stores[0],
    )
    .0;
    let Frame::Hello {
        space,
        proof,
        token,
        ..
    } = hello_of(&net, 1, 0)
    else {
        panic!("not a Hello");
    };
    let newer = Frame::Hello {
        protocol: PROTOCOL + 1,
        space,
        proof: proof.clone(),
        acl_head: None,
        token,
    };
    let close = old
        .on_frame(newer, &mut net.stores[0])
        .unwrap()
        .close
        .unwrap();
    assert!(close.starts_with("zaktualizuj"));

    let mut forked = Session::new(
        local_of(&net.stores[0], endpoint(0)),
        endpoint(1),
        &net.stores[0],
    )
    .0;
    let fake = Frame::Hello {
        protocol: PROTOCOL,
        space,
        proof,
        acl_head: Some(AclHead {
            index: owner_head.index,
            hash: [0; 32],
        }),
        token: None,
    };
    let close = forked
        .on_frame(fake, &mut net.stores[0])
        .unwrap()
        .close
        .unwrap();
    assert!(close.contains("rozwidlenie"));
}

#[test]
fn frames_before_hello_or_have_close_the_session() {
    let dirs = tempdirs(1);
    let mut net = Net::new(team(&roots(&dirs), &[]));
    let mut s = Session::new(
        local_of(&net.stores[0], endpoint(0)),
        endpoint(1),
        &net.stores[0],
    )
    .0;
    assert!(
        s.on_frame(Frame::Have(vec![]), &mut net.stores[0])
            .unwrap()
            .close
            .is_some()
    );
    assert!(!s.ready());
    assert!(s.live(b"x", &net.stores[0]).is_none());
}

#[test]
fn live_edit_is_relayed_through_the_middle_device() {
    // A (owner) <-> B <-> C: A and C never talk, B relays A's messages with A's signatures intact
    let dirs = tempdirs(3);
    let mut net = Net::new(team(&roots(&dirs), &[Role::Editor, Role::Editor]));
    let id = net.stores[0].opened.space.create_note("n.md").unwrap();
    net.stores[0]
        .opened
        .space
        .insert_text(&id, 0, "A ")
        .unwrap();
    net.connect(0, 1);
    net.connect(1, 2);
    net.settle();
    assert!(net.failures.is_empty(), "{:?}", net.failures);

    net.edit(0, &id, 0, "B ");
    net.settle();
    assert!(net.failures.is_empty(), "{:?}", net.failures);
    assert!(!net.open_between(0, 2));
    assert_eq!(net.texts(&id), vec!["B A ", "B A ", "B A "]);
    let owner = net.stores[0].opened.cert.device;
    let owner_msgs = net.stores[0].opened.space.messages().unwrap().len();
    assert_eq!(
        net.stores[2]
            .opened
            .space
            .messages()
            .unwrap()
            .iter()
            .filter(|m| m[17..49] == owner)
            .count(),
        owner_msgs
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(16))]

    /// Three devices, random edits, links opened and dropped, and frames delivered in random order
    /// (in order within a link). Once every pair is linked and the network is quiet, all texts match.
    #[test]
    fn three_devices_converge(
        steps in proptest::collection::vec(
            (0u8..4, 0usize..3, 0usize..3, 0u32..64, "[a-zż]{1,3}"),
            1..16,
        )
    ) {
        let dirs = tempdirs(3);
        let mut net = Net::new(team(&roots(&dirs), &[Role::Editor, Role::Editor]));
        let id = net.stores[0].opened.space.create_note("n.md").unwrap();
        net.stores[0].opened.space.insert_text(&id, 0, "start").unwrap();

        for (op, a, b, at, text) in steps {
            match op {
                0 => {
                    if net.stores[a].opened.space.notes().iter().any(|(n, _)| *n == id) {
                        let len = net.stores[a].opened.space.text(&id).unwrap().encode_utf16().count();
                        let at = at as usize % (len + 1);
                        net.edit(a, &id, at as u32, &text);
                    }
                }
                1 => {
                    if a != b && !net.open_between(a, b) {
                        net.connect(a, b);
                    }
                }
                2 => {
                    let pending = net.pending();
                    if let Some(&(l, e)) = pending.get(at as usize % pending.len().max(1)) {
                        net.deliver(l, e);
                    }
                }
                _ => {
                    let open: Vec<usize> = (0..net.links.len()).filter(|l| net.links[*l].open).collect();
                    if let Some(&l) = open.get(a % open.len().max(1)) {
                        net.close(l);
                    }
                }
            }
        }

        for (a, b) in [(0, 1), (0, 2), (1, 2)] {
            if !net.open_between(a, b) {
                net.connect(a, b);
            }
        }
        net.settle();
        prop_assert!(net.failures.is_empty(), "{:?}", net.failures);
        let texts = net.texts(&id);
        prop_assert_eq!(&texts[0], &texts[1]);
        prop_assert_eq!(&texts[0], &texts[2]);
        let counts: Vec<usize> = net.stores.iter().map(|s| s.opened.space.messages().unwrap().len()).collect();
        prop_assert_eq!(counts[0], counts[1]);
        prop_assert_eq!(counts[0], counts[2]);
    }
}

#[test]
fn a_third_have_on_one_connection_closes_it() {
    let dirs = tempdirs(2);
    let mut net = Net::new(team(&roots(&dirs), &[Role::Editor]));
    let editor_hello = hello_of(&net, 1, 0);
    let (mut owner, _) = Session::new(
        local_of(&net.stores[0], endpoint(0)),
        endpoint(1),
        &net.stores[0],
    );
    owner.on_frame(editor_hello, &mut net.stores[0]).unwrap();
    // its Hello's Have, then the one a sync run asks again with: both allowed, a third is not
    assert!(
        owner
            .on_frame(Frame::Have(vec![]), &mut net.stores[0])
            .unwrap()
            .close
            .is_none()
    );
    assert!(
        owner
            .on_frame(Frame::Have(vec![]), &mut net.stores[0])
            .unwrap()
            .close
            .is_none()
    );
    let step = owner
        .on_frame(Frame::Have(vec![]), &mut net.stores[0])
        .unwrap();
    assert!(step.close.is_some());
}
